from playwright.sync_api import sync_playwright, expect
import time, datetime, sys
T = str(int(time.time())); EM = f'admin{T}@grace.org'; LEM = f'leader{T}@grace.org'
today = datetime.date.today(); bd = today.replace(year=1990).isoformat()
errs = []
def shot(pg, name): pg.screenshot(path=f'{S}/{name}.png', full_page=False)
S = sys.argv[1]
with sync_playwright() as p:
    b = p.chromium.launch(executable_path='/opt/pw-browsers/chromium')
    ctx = b.new_context(viewport={'width':1200,'height':850}); ctx.add_init_script("localStorage.setItem('apiUrl','http://localhost:8788')")
    pg = ctx.new_page()
    pg.on('pageerror', lambda e: errs.append('PAGEERR '+str(e)))
    pg.on('console', lambda m: errs.append('CONSOLE '+m.text) if m.type=='error' and '404' not in m.text else None)
    nav = lambda name, h2: (pg.click(f'nav >> text={name}'), pg.wait_for_selector(f'main h2:has-text("{h2}")'))
    modal = lambda: pg.locator('.modal')
    pg.goto('http://localhost:5173'); pg.click('text=Register a new church')
    pg.fill('[name=church]','Grace Chapel'); pg.fill('[name=name]','Pastor Joel Mensah'); pg.fill('[name=email]',EM); pg.fill('[name=password]','password123')
    pg.click('button:has-text("Create church account")'); pg.wait_for_selector('text=Welcome, Pastor'); pg.wait_for_selector('text=Getting started'); shot(pg,'01_home_empty')
    # ministries
    nav('Ministries','Ministries')
    for n in ['Youth','Choir']:
        pg.click('button:has-text("New ministry")'); modal().locator('[name=name]').fill(n); modal().locator('[name=leader]').fill(f'{n} Leader'); modal().locator('button:has-text("Save")').click()
        pg.wait_for_selector(f'.card b:has-text("{n}")')
    # members
    nav('Members','Members')
    def add_member(name, phone, ministry, status='member', birthday='', household=''):
        pg.click('button:has-text("Add member")'); m = modal()
        m.locator('[name=name]').fill(name); m.locator('[name=phone]').fill(phone); m.locator('[name=status]').select_option(status)
        if birthday: m.locator('[name=birthday]').fill(birthday)
        if household: m.locator('[name=newHousehold]').fill(household)
        if ministry: m.locator(f'label.check:has-text("{ministry}") input').check()
        m.locator('button:has-text("Add member")').click(); pg.wait_for_selector(f'td b:has-text("{name}")')
    add_member('Ama Mensah','0244123456','Youth',birthday=bd,household='Mensah family')
    add_member('Kofi Boateng','0555000111','Choir')
    add_member('Esi Owusu','0200111222','', status='visitor')
    pg.fill('input[type=search]','kofi'); assert pg.locator('tbody tr:visible').count()==1
    pg.fill('input[type=search]',''); shot(pg,'02_members')
    pg.click('td b:has-text("Ama Mensah")'); pg.wait_for_selector('.modal >> text=Mensah family'); shot(pg,'03_profile'); pg.click('.modal-head button')
    # attendance x3
    nav('Attendance','Attendance')
    for i,(d,present) in enumerate([((today-datetime.timedelta(days=14)).isoformat(),['Ama','Kofi','Esi']),((today-datetime.timedelta(days=7)).isoformat(),['Ama','Esi']),(today.isoformat(),['Esi'])]):
        pg.click('button:has-text("Take attendance")'); m = modal(); m.locator('[name=date]').fill(d); m.locator('[name=extra]').fill('5')
        for n in present: m.locator(f'label.check:has-text("{n}") input').check()
        m.locator('button:has-text("Save attendance")').click(); pg.wait_for_selector(f'tbody tr >> nth={i}')
    pg.wait_for_selector('.chart'); shot(pg,'04_attendance')
    # finance
    nav('Finance','Finance')
    def rec(t, amount, member='', ministry='', method='cash'):
        pg.click('button:has-text("Record")'); m = modal(); m.locator('[name=type]').select_option(t); m.locator('[name=amount]').fill(str(amount)); m.locator('[name=method]').select_option(method)
        if member: m.locator('[name=memberId]').select_option(label=member)
        if ministry: m.locator('[name=ministryId]').select_option(label=ministry)
        m.locator('button:has-text("Record")').click(); pg.wait_for_selector('.toast')
    pg.click('button:has-text("Pledge")'); m = modal(); m.locator('[name=memberId]').select_option(label='Ama Mensah'); m.locator('[name=title]').fill('Building fund'); m.locator('[name=amount]').fill('500'); m.locator('button:has-text("Save")').click(); pg.wait_for_selector('.toast')
    rec('tithe',150,'Ama Mensah',method='mobile money'); rec('expense',40); rec('offering',20,ministry='Youth')
    pg.click('button:has-text("Record")'); m = modal(); m.locator('[name=type]').select_option('pledge payment'); m.locator('[name=memberId]').select_option(label='Ama Mensah')
    m.locator('[name=pledgeId]').select_option(index=1); m.locator('[name=amount]').fill('100'); m.locator('button:has-text("Record")').click(); pg.wait_for_selector('.toast')
    pg.wait_for_timeout(600); print('finance cards:', pg.inner_text('main .grid').replace('\n',' | ')); shot(pg,'05_finance')
    pg.click('.tabs >> text=Pledges'); pg.wait_for_selector('text=Building fund'); assert '20%' in pg.inner_text('main'); shot(pg,'06_pledges')
    # reports
    nav('Reports','Reports'); pg.select_option('select[name=m]', label='Ama Mensah'); pg.click('button:has-text("View statement")'); pg.wait_for_selector('.receipt >> text=250'); shot(pg,'07_reports')
    # announcements
    nav('Notices','Announcements'); pg.fill('[name=text]','Harvest planning meeting after service.'); pg.click('button:has-text("Post announcement")'); pg.wait_for_selector('.feed >> text=Harvest planning')
    # dashboard
    nav('Home','Welcome'); pg.wait_for_selector('text=Birthdays this month'); pg.wait_for_selector('.chart'); shot(pg,'08_home')
    dash = pg.inner_text('main'); assert 'Ama Mensah' in dash and 'Esi Owusu' in dash, dash
    assert 'Everyone is attending' in dash  # Kofi attended 1 of the last 3, so nobody is flagged
    # staff -> leader
    nav('Staff','Staff'); pg.click('button:has-text("Add account")'); m = modal(); m.locator('[name=name]').fill('Youth Leader'); m.locator('[name=email]').fill(LEM); m.locator('[name=password]').fill('leaderpass1'); m.locator('[name=ministry]').select_option(label='Youth')
    m.locator('button:has-text("Create account")').click(); pg.wait_for_selector(f'td:has-text("{LEM}")'); shot(pg,'09_staff')
    # settings
    nav('Settings','Settings'); pg.wait_for_selector('text=Grace Chapel'); shot(pg,'10_settings')
    pg.wait_for_function("!document.querySelector('.status').innerText.includes('waiting')", timeout=15000)
    # leader session
    pg.click('nav >> text=Sign out'); pg.wait_for_selector('text=Register a new church')
    pg.fill('[name=email]',LEM); pg.fill('[name=password]','leaderpass1'); pg.click('button:has-text("Sign in")'); pg.wait_for_selector('main h2:has-text("My ministry")')
    tabs = pg.locator('nav button').all_inner_texts(); print('leader tabs:', [t.replace('\n',' ') for t in tabs])
    assert not any('Staff' in t or 'Reports' in t or 'Notices' in t for t in tabs)
    pg.wait_for_selector('.card b:has-text("Youth")'); assert pg.locator('.card b:has-text("Choir")').count()==0; shot(pg,'11_leader_ministry')
    nav('Members','Members'); rows = pg.locator('tbody tr td b').all_inner_texts(); print('leader members:', rows); assert rows==['Ama Mensah']
    nav('Finance','Finance'); txt = pg.inner_text('main'); print('leader finance:', txt.replace('\n',' | ')[:200]); assert 'Building' not in txt and '150.00' not in txt
    nav('Attendance','Attendance'); shot(pg,'12_leader_att')
    # mobile
    pg.set_viewport_size({'width':390,'height':800}); nav('Members','Members'); shot(pg,'13_mobile_members')
    pg.click('td b:has-text("Ama Mensah")'); pg.wait_for_selector('.modal'); shot(pg,'14_mobile_modal')
    print('ERRORS:', errs); b.close()
    print('WALKTHROUGH OK' if not errs else 'WALKTHROUGH HAD ERRORS')
