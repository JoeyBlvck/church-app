// Local-first data layer. All reads/writes hit the local store immediately
// (works offline). sync() pushes dirty records and pulls server changes.

export function createRepo(store, { baseUrl, fetchImpl = globalThis.fetch, now = () => Date.now(), uuid = () => crypto.randomUUID() } = {}) {
  const listeners = new Set();
  const emit = () => listeners.forEach((f) => f());

  async function token() { return store.getMeta('token'); }

  async function http(method, path, body) {
    const t = await token();
    const r = await fetchImpl(baseUrl + path, {
      method,
      headers: { 'content-type': 'application/json', ...(t && { authorization: `Bearer ${t}` }) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const json = await r.json().catch(() => ({}));
    if (!r.ok) throw Object.assign(new Error(json.error ?? `HTTP ${r.status}`), { status: r.status });
    return json;
  }

  const repo = {
    onChange(f) { listeners.add(f); return () => listeners.delete(f); },

    // ---- session (cached so the app opens offline) ----
    async login(email, password) {
      const s = await http('POST', '/auth/login', { email, password });
      await repo._startSession(s); return s.user;
    },
    async registerChurch(input) {
      const s = await http('POST', '/auth/register-church', input);
      await repo._startSession(s); return s.user;
    },
    async _startSession(s) {
      const prev = await store.getMeta('user');
      if (prev && prev.tenantId !== s.user.tenantId) await store.clear(); // never mix churches
      await store.setMeta('token', s.token);
      await store.setMeta('user', s.user);
    },
    user: () => store.getMeta('user'),
    async logout() { await store.clear(); emit(); },
    createStaff: (input) => http('POST', '/users', input),
    listStaff: () => http('GET', '/users'),
    updateStaff: (input) => http('POST', '/users/update', input),
    changePassword: (current, next) => http('POST', '/auth/change-password', { current, next }),
    // photo is optional: omit it to leave whatever's on file untouched, or pass a compressed
    // data URI (see ui.js compressImage) or null to set/remove it.
    async updateProfile(name, email, photo) {
      const { user } = await http('POST', '/auth/update-profile', { name, email, ...(photo !== undefined && { photo }) });
      await store.setMeta('user', user);
      emit(); return user;
    },
    async churchName() { try { const m = await http('GET', '/me'); await store.setMeta('church', m.church); return m.church; } catch { return store.getMeta('church'); } },

    // ---- SMS (Arkesel) — direct server calls, not local-first: the API key never leaves the
    // server, and sending is an immediate action rather than something to queue offline ----
    getSmsConfig: () => http('GET', '/sms/config'),
    saveSmsConfig: (apiKey, senderId) => http('POST', '/sms/config', { apiKey, senderId }),
    // ministryIds: [] (or omitted) means the whole church; one or more ids targets just those
    // ministries' members — independent of which single ministry (if any) the notice itself
    // was posted under.
    sendSms: (message, ministryIds) => http('POST', '/sms/send', { message, ministryIds: ministryIds?.length ? ministryIds : undefined }),

    // ---- Paystack (online giving) — same pattern as SMS above: the secret key never leaves
    // the server. The public giving page (app/give.html) is a separate, unauthenticated page —
    // it talks to the server directly, not through this repo.
    getPaystackConfig: () => http('GET', '/paystack/config'),
    savePaystackConfig: (secretKey, publicKey) => http('POST', '/paystack/config', { secretKey, publicKey }),

    // ---- WhatsApp (broadcast + check-in-by-reply) — same "bring your own account" pattern as
    // SMS/Paystack above: the access token never leaves the server. Inbound check-in replies and
    // the webhook verification handshake are handled entirely server-side (server/src/app.js's
    // /whatsapp/webhook) — nothing for this repo to do there.
    getWhatsappConfig: () => http('GET', '/whatsapp/config'),
    saveWhatsappConfig: (config) => http('POST', '/whatsapp/config', config),
    sendWhatsapp: (message, ministryIds) => http('POST', '/whatsapp/send', { message, ministryIds: ministryIds?.length ? ministryIds : undefined }),

    // ---- QR self-check-in — unlike SMS/Paystack/WhatsApp above, there's no third-party account
    // to connect: the QR code just encodes a link to this church's own public check-in page
    // (app/checkin.html, built client-side from the signed-in user's own tenantId — see
    // settings.js). The only server-side setting is what to call the attendance record it creates.
    getCheckinConfig: () => http('GET', '/checkin/config'),
    saveCheckinConfig: (serviceName) => http('POST', '/checkin/config', { serviceName }),
    // A bare {id, name}[] of every member in the church — for a ministry leader picking someone
    // to add to their ministry's roster (ministries.js), since their normal local-first sync only
    // ever brings down members already in one of their own ministries.
    memberDirectory: () => http('GET', '/members/directory').then((r) => r.members),
    // Add/remove one ministry from a member's roster (ministries.js's "Add member"/"×" controls).
    // Direct server call rather than repo.save: the server already holds the full authoritative
    // record and only flips one field, so the caller never needs (and, for a leader, may not
    // even have) that member's other fields. The updated record comes straight back and is
    // written into the local store already-synced (dirty: false) — no separate sync() needed.
    async rosterChange(memberId, ministryId, action) {
      const { member, seq } = await http('POST', '/members/roster', { memberId, ministryId, action });
      await store.put({ collection: 'members', id: memberId, data: member, updatedAt: now(), deleted: false, dirty: false, seq });
      emit();
      return member;
    },

    // ---- data ----
    async list(collection) {
      return (await store.all(collection)).filter((r) => !r.deleted)
        .map((r) => r.data);
    },
    async get(collection, id) {
      const r = await store.get(collection, id);
      return r && !r.deleted ? r.data : undefined;
    },
    async save(collection, data) {
      const id = data.id ?? uuid();
      const cur = await store.get(collection, id); // keep the known server version (seq); only a create starts at 0
      await store.put({ collection, id, data: { ...data, id }, updatedAt: now(), deleted: false, dirty: true, seq: cur?.seq ?? 0 });
      emit(); return id;
    },
    async remove(collection, id) {
      const r = await store.get(collection, id);
      if (!r) return;
      await store.put({ ...r, deleted: true, updatedAt: now(), dirty: true });
      emit();
    },

    // ---- maintenance ----
    // Re-download everything the server says this user may see (e.g. after a role or ministry change).
    async resync() {
      if (await repo.pending()) throw new Error('Sync your pending changes first.');
      await store.wipeData(); return repo.sync();
    },
    async backup() {
      const all = await store.everything();
      return JSON.stringify({ exportedAt: new Date().toISOString(), user: await store.getMeta('user'),
        records: all.filter((r) => !r.deleted).map(({ collection, id, data }) => ({ collection, id, data })) }, null, 2);
    },
    lastSync: () => store.getMeta('lastSync'),

    // ---- sync ----
    async pending() { return (await store.dirty()).length; },

    async sync() {
      // 1) push
      const dirty = await store.dirty();
      let rejected = 0, conflicted = 0;
      if (dirty.length) {
        const { results } = await http('POST', '/sync/push', {
          changes: dirty.map((r) => ({ collection: r.collection, id: r.id, data: r.data, updatedAt: r.updatedAt, deleted: r.deleted, baseSeq: r.seq ?? 0 })),
        });
        for (const res of results) {
          const rec = await store.get(res.collection, res.id);
          if (!rec) continue;
          // Only act if the record wasn't edited again mid-flight (that edit will push next time).
          const sent = dirty.find((d) => d.collection === res.collection && d.id === res.id);
          const stillSame = rec.updatedAt === sent.updatedAt;
          if (res.status === 'forbidden' || res.status === 'invalid') {
            rejected++;
            if (stillSame) await store.put({ ...rec, dirty: false, rejected: res.status });
          } else if (res.status === 'conflict') {
            // Someone else committed a newer version first. Drop our edit and adopt theirs
            // right away, rather than retrying a write that will only conflict again.
            conflicted++;
            if (stillSame) await store.put({ collection: res.collection, id: res.id, data: res.data,
              updatedAt: res.updatedAt, deleted: res.deleted, dirty: false, seq: res.seq, rejected: 'conflict' });
          } else if (stillSame) {
            await store.put({ collection: res.collection, id: res.id, data: rec.data,
              updatedAt: rec.updatedAt, deleted: rec.deleted, dirty: false, seq: res.seq });
          }
        }
      }
      // 2) pull
      let cursor = (await store.getMeta('cursor')) ?? 0;
      let more = true, pulled = 0;
      while (more) {
        const page = await http('GET', `/sync/pull?since=${cursor}`);
        for (const c of page.changes) {
          const local = await store.get(c.collection, c.id);
          if (local?.dirty) continue; // a pending local edit will be reconciled by its own push (ok or conflict)
          await store.put({ collection: c.collection, id: c.id, data: c.data, updatedAt: c.updatedAt, deleted: c.deleted, dirty: false, seq: c.seq });
          pulled++;
        }
        cursor = page.cursor; more = page.more;
        await store.setMeta('cursor', cursor);
      }
      await store.setMeta('lastSync', now());
      emit();
      return { pushed: dirty.length - rejected - conflicted, rejected, conflicted, pulled };
    },
  };
  return repo;
}
