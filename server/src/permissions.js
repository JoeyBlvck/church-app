// Role-based access with ministry scoping. Single source of truth for what a
// user may read/write during sync.
export const COLLECTIONS = [
  'members', 'households', 'ministries', 'attendance',
  'transactions', 'pledges', 'messages', 'ministryUpdates', 'programmes', 'registrations', 'accounts', 'funds', 'settings',
];

// Collections a role may touch at all (leaders are further scoped by ministry).
// 'programmes' (the annual programme calendar), 'registrations' (who's signed up for one of
// those programmes) and 'settings' (church logo, motto, location, district, region) are all
// church-wide, not ministry-scoped — everyone may read them, but only office staff can write:
// programmes/registrations via owner/admin/secretary (the same roles that see the Programmes
// tab at all — see main.js's TABS), settings via owner/admin only (nobody else's write list
// includes it below).
// 'accounts' (bank/cash accounts) and 'funds' (designated giving with a goal, e.g. "Building
// Fund") are also church-wide, but the opposite way round from programmes: they're the church's
// overall financial position, so they're gated the same as reports.js's own canFinance —
// owner/admin/treasurer only. A leader can still post a transaction (their own ministry's), but
// never sees the accounts/funds themselves, same as leaders never see pledges.
const ACCESS = {
  owner: { read: 'all', write: 'all' },
  admin: { read: 'all', write: 'all' },
  treasurer: {
    read: ['transactions', 'pledges', 'accounts', 'funds', 'members', 'households', 'ministries', 'programmes', 'registrations', 'settings'],
    write: ['transactions', 'pledges', 'accounts', 'funds'],
  },
  secretary: {
    read: ['members', 'households', 'ministries', 'attendance', 'messages', 'ministryUpdates', 'programmes', 'registrations', 'settings'],
    write: ['members', 'households', 'attendance', 'messages', 'ministryUpdates', 'programmes', 'registrations'],
  },
  leader: {
    read: ['members', 'ministries', 'attendance', 'transactions', 'ministryUpdates', 'messages', 'programmes', 'registrations', 'settings'],
    write: ['members', 'attendance', 'transactions', 'ministryUpdates'],
  },
};

const has = (rule, c) => rule === 'all' || rule.includes(c);

// The ministry a record belongs to, derived from its data.
export function ministryOf(collection, data) {
  if (collection === 'ministries') return data.id ?? null;
  return data.ministryId ?? null;
}

function leaderCanSee(user, collection, data) {
  const mine = user.ministryIds;
  if (collection === 'ministries') return mine.includes(data.id);
  if (collection === 'households') return false; // family details stay with office staff
  if (collection === 'programmes') return true; // church-wide calendar, not ministry-specific
  if (collection === 'registrations') return true; // who's signed up for a church-wide programme
  if (collection === 'settings') return true; // church-wide profile (logo, motto, location…)
  if (collection === 'members') {
    return (data.ministryIds ?? []).some((m) => mine.includes(m));
  }
  // Whole-church (no ministryId) attendance — e.g. the main Sunday service register — reflects
  // into a leader's ministry view too, since their own members' attendance there still matters
  // to them, alongside records taken specifically for their ministry's own meetings.
  if (collection === 'attendance') return !data.ministryId || mine.includes(data.ministryId);
  // messages: only ones addressed to their ministry
  return mine.includes(data.ministryId);
}

export function canRead(user, collection, data) {
  const rule = ACCESS[user.role];
  if (!rule || !has(rule.read, collection)) return false;
  if (user.role !== 'leader') return true;
  return leaderCanSee(user, collection, data);
}

export function canWrite(user, collection, data, existing) {
  const rule = ACCESS[user.role];
  if (!rule || !has(rule.write, collection)) return false;
  if (user.role !== 'leader') return true;
  // Leaders may only write inside their own ministries, and may not move a
  // record out of (or into) a ministry they don't lead.
  if (collection === 'members') {
    const touches = (d) => (d?.ministryIds ?? []).some((m) => user.ministryIds.includes(m));
    if (touches(data) && (!existing || touches(existing))) return true;
    // Roster-only exception: a leader may add or remove one of their OWN ministries from a
    // member's ministryIds — this is how a ministry leader adds/removes members from their
    // ministry's roster (ministries.js) — even for someone who isn't already "theirs" by the
    // rule above. It never grants any other edit: every other field must be byte-identical to
    // the existing record, and only ministryIds the leader themselves leads may change.
    if (!existing) return false;
    const oldIds = existing.ministryIds ?? [];
    const newIds = data.ministryIds ?? [];
    const changedIds = [...new Set([...oldIds, ...newIds])].filter((id) => oldIds.includes(id) !== newIds.includes(id));
    if (!changedIds.length || !changedIds.every((id) => user.ministryIds.includes(id))) return false;
    const stripMinistryIds = ({ ministryIds, ...rest }) => JSON.stringify(rest);
    return stripMinistryIds(data) === stripMinistryIds(existing);
  }
  const inMine = (d) => d && user.ministryIds.includes(d.ministryId);
  return inMine(data) && (!existing || inMine(existing));
}
