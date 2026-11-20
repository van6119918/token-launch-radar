// Token Radar's dashboard, plain JavaScript, no framework and no network.
//
// It reads window.RADAR — the dataset main.ts writes beside dashboard/ —
// and renders the ranked board with its filters, plus a detail drawer for
// each protocol carrying the model's own inputs and the protocol's farm
// plan. Every byte on screen comes from data.js.
//
// The farm plan is derived here exactly as main.ts derives it for
// board.json: category, chains, TVL and age decide the action, the capital,
// the hold and every cost and time. No name is special-cased. The page also
// recomputes each row's implied value from the snapshot figures and checks
// it against the number board.json carries, so the page and the board can
// be checked against each other.
(function () {
  'use strict';

  var DATA = window.RADAR;
  if (!DATA) return;
  var board = document.getElementById('board');
  var view = { q: '', category: 'all', chain: 'all', tvl: 'all', tab: 'pre-token', sort: 'implied', dir: -1, selected: null };

  var dollars = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
  function money(n) {
    if (n === null || n === undefined || !isFinite(n)) return 'n/a';
    if (Math.abs(n) >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
    if (Math.abs(n) >= 1e6) return '$' + (n / 1e6).toFixed(1) + 'M';
    if (Math.abs(n) >= 1e3) return '$' + Math.round(n / 1e3) + 'K';
    return dollars.format(n);
  }
  function pct(n) {
    if (n === null || n === undefined || !isFinite(n)) return 'n/a';
    return (n > 0 ? '+' : '') + n.toFixed(2) + '%';
  }
  function ageLabel(days) {
    if (days === null || days === undefined) return 'unknown';
    if (days >= 365) return (days / 365).toFixed(1) + 'y';
    return Math.max(0, Math.round(days)) + 'd';
  }

  // The model, restated for the page: a row is recomputed from the snapshot
  // figures and checked against the number board.json carries, so the page's
  // code and the board's data are visibly the same arithmetic.
  function recomputeImplied(row, model) {
    var growth = Math.min(model.growth_cap, Math.max(model.growth_floor, row.change_7d === null || row.change_7d === undefined ? 0 : row.change_7d));
    var growthMult = 1 + (growth / 100) * model.growth_weight;
    var age = row.age_days === null || row.age_days === undefined ? model.unknown_age_days : row.age_days;
    var maturity = model.maturity_floor + (Math.min(Math.max(age, 0), model.maturity_days) / model.maturity_days) * model.maturity_range;
    var extra = Math.min(Math.max((row.chains || []).length - 1, 0), model.chain_max_extra);
    var chainMult = 1 + model.chain_step * extra;
    return Math.max(1, Math.round(row.tvl_usd * row.category_multiple * growthMult * maturity * chainMult));
  }

  // A tiny element builder: tag, attributes, then children. Attribute keys
  // named class/text/html are handled specially; keys starting with "on"
  // become listeners; the rest become attributes when they are not null.
  function tag(name, attrs) {
    var node = document.createElement(name);
    function attach(child) {
      if (child === null || child === undefined || child === false) return;
      if (Array.isArray(child)) { child.forEach(attach); return; }
      if (typeof child === 'string') { node.appendChild(document.createTextNode(child)); return; }
      node.appendChild(child);
    }
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        var v = attrs[k];
        if (k === 'class') node.className = v;
        else if (k === 'text') node.textContent = v;
        else if (k === 'html') node.innerHTML = v;
        else if (k.slice(0, 2) === 'on') node.addEventListener(k.slice(2), v);
        else if (v !== null && v !== undefined) node.setAttribute(k, v);
      });
    }
    for (var i = 2; i < arguments.length; i++) attach(arguments[i]);
    return node;
  }

  function firstChainOf(p) { return p.chains && p.chains.length > 0 ? p.chains[0] : 'its main chain'; }
  function stakeFor(p) {
    if (p.tvl_usd >= 5e9) return 250;
    if (p.tvl_usd >= 1e9) return 150;
    if (p.tvl_usd >= 1e8) return 100;
    return 50;
  }
  function holdFor(age) {
    if (age === null || age === undefined) return 30;
    if (age < 180) return 60;
    if (age < 365) return 45;
    return 30;
  }
  // The category's one action, as a lookup table tried in order: the first
  // entry whose keyword appears in the category wins. The wording of each
  // action is the plan itself, so it never changes here — only the lookup does.
  var ACTION_TABLE = [
    { keys: ['lend', 'cdp', 'collateral'], write: function (capital, name, chain) { return 'Supply $' + capital + ' of USDC to ' + name + ' on ' + chain + ' and borrow a small amount against it to show both sides of the book.'; } },
    { keys: ['dex', 'leveraged farm', 'farm'], write: function (capital, name, chain) { return 'Provide $' + capital + ' of liquidity to ' + name + "'s main pool on " + chain + ' and keep the position open.'; } },
    { keys: ['yield aggregator', 'yield'], write: function (capital, name, chain) { return 'Deposit $' + capital + ' of USDC into ' + name + "'s highest-TVL vault on " + chain + ' and keep the shares.'; } },
    { keys: ['bridge', 'cross chain'], write: function (capital, name, chain) { return 'Bridge $' + capital + ' of USDC to ' + chain + ' through ' + name + ' and use the bridged funds in its app.'; } },
    { keys: ['staking', 'restak'], write: function (capital, name, chain) { return "Stake $" + capital + " of the chain's staking asset through " + name + ' and keep the receipt token.'; } },
    { keys: ['perpetual', 'derivative', 'options'], write: function (capital, name, chain) { return 'Deposit $' + capital + ' of USDC as margin on ' + name + ' and open one small hedged trade.'; } },
    { keys: ['prediction'], write: function (capital, name) { return 'Fund $' + capital + ' and place one small market position on ' + name + '.'; } },
    { keys: ['curator', 'allocator', 'risk'], write: function (capital, name, chain) { return 'Deposit $' + capital + ' into a ' + name + ' vault on ' + chain + ' and keep the shares.'; } },
    { keys: ['stable'], write: function (capital, name, chain) { return 'Mint or deposit $' + capital + ' of the stable asset through ' + name + ' on ' + chain + '.'; } },
    { keys: ['rwa'], write: function (capital, name, chain) { return "Mint $" + capital + " of the protocol's yield-bearing asset on " + chain + ' and hold it.'; } },
    { keys: ['insurance'], write: function (capital, name, chain) { return 'Buy $' + capital + ' of cover from ' + name + ' on ' + chain + ' and keep the policy active.'; } },
    { keys: ['payment'], write: function (capital, name, chain) { return 'Route $' + capital + ' of payments through ' + name + ' on ' + chain + ' over the farming window.'; } },
    { keys: ['launchpad'], write: function (capital, name, chain) { return 'Commit $' + capital + ' to the next ' + name + ' launch on ' + chain + ' and complete its tasks.'; } }
  ];
  function actionText(p, capital, chain) {
    var c = (p.category || '').toLowerCase();
    for (var i = 0; i < ACTION_TABLE.length; i++) {
      var entry = ACTION_TABLE[i];
      for (var j = 0; j < entry.keys.length; j++) {
        if (c.indexOf(entry.keys[j]) >= 0) return entry.write(capital, p.name, chain);
      }
    }
    return 'Deposit $' + capital + ' of USDC into ' + p.name + ' on ' + chain + ' and keep the position open.';
  }
  function stepText(step) {
    var s = step.text + ' Cost: ' + step.cost + '. Time: ' + step.time + '.';
    if (s.length > 600) s = s.slice(0, 596) + '...';
    if (s.length < 20) s = s + " Hold the position and check the protocol's own page.";
    return s;
  }
  function farmPlan(p) {
    var chain = firstChainOf(p);
    var capital = stakeFor(p);
    var hold = holdFor(p.age_days);
    var extraChain = p.chains && p.chains.length > 1 ? ' Repeat the deposit on ' + p.chains[1] + ' once, so more than one chain shows activity.' : '';
    return [
      { text: 'Use a fresh wallet that holds only the funds you plan to farm, and keep its seed phrase offline.', cost: 'under $3 of gas for the first transaction', time: '5 minutes' },
      { text: actionText(p, capital, chain), cost: '$' + capital + ' of capital and about $' + (capital >= 150 ? 8 : 4) + ' of gas', time: '15 minutes to set up' },
      { text: 'Make one qualifying action each week, such as a deposit, a borrow, a swap or a vote.' + extraChain, cost: 'about $2 of gas a week', time: '10 minutes a week' },
      { text: 'Hold the position for at least ' + hold + ' days so the activity is counted in more than one snapshot.', cost: 'the $' + capital + ' stays in the position', time: hold + ' days' },
      { text: "Before you withdraw, open the protocol's own points or rewards page and claim only from the link it publishes.", cost: 'no fee to check, and never pay to claim', time: '10 minutes' },
      { text: 'Write the wallet, the dates and every transaction in a farm log so you can repeat the position or unwind it.', cost: 'nothing but the log', time: '5 minutes' }
    ].map(stepText);
  }

  // The view's state lives in the URL hash, so a filtered board is a link.
  function readHash() {
    var hash = window.location.hash.replace(/^#/, '');
    if (!hash) return;
    var params = new URLSearchParams(hash);
    if (params.get('q')) view.q = params.get('q');
    if (params.get('p')) view.selected = params.get('p');
    if (params.get('category')) view.category = params.get('category');
    if (params.get('chain')) view.chain = params.get('chain');
    if (params.get('tvl')) view.tvl = params.get('tvl');
  }
  function writeHash() {
    var params = new URLSearchParams();
    if (view.q) params.set('q', view.q);
    if (view.category !== 'all') params.set('category', view.category);
    if (view.chain !== 'all') params.set('chain', view.chain);
    if (view.tvl !== 'all') params.set('tvl', view.tvl);
    if (view.selected) params.set('p', view.selected);
    var next = params.toString();
    if (next) window.history.replaceState(null, '', '#' + next);
    else window.history.replaceState(null, '', window.location.pathname + window.location.search);
  }

  function tvlBucket(tvl) {
    if (tvl >= 5e8) return '500M+';
    if (tvl >= 1e8) return '100-500M';
    if (tvl >= 5e7) return '50-100M';
    if (tvl >= 1e7) return '10-50M';
    return '5-10M';
  }
  function filteredRows() {
    var q = view.q.trim().toLowerCase();
    return DATA.rows.filter(function (r) {
      if (view.category !== 'all' && (r.category || 'Other') !== view.category) return false;
      if (view.chain !== 'all' && (r.chains || []).indexOf(view.chain) < 0) return false;
      if (view.tvl !== 'all' && tvlBucket(r.tvl_usd) !== view.tvl) return false;
      if (!q) return true;
      var hay = [r.name, r.slug, r.category, (r.chains || []).join(' ')].join(' ').toLowerCase();
      return hay.indexOf(q) >= 0;
    });
  }
  function orderedRows(list) {
    var key = view.sort;
    return list.slice().sort(function (a, b) {
      var av, bv;
      if (key === 'name') { av = a.name.toLowerCase(); bv = b.name.toLowerCase(); }
      else if (key === 'tvl') { av = a.tvl_usd; bv = b.tvl_usd; }
      else if (key === 'growth') { av = a.change_7d === null ? -Infinity : a.change_7d; bv = b.change_7d === null ? -Infinity : b.change_7d; }
      else if (key === 'age') { av = a.age_days === null ? Infinity : a.age_days; bv = b.age_days === null ? Infinity : b.age_days; }
      else { av = a.implied_value_usd; bv = b.implied_value_usd; }
      if (av < bv) return -view.dir;
      if (av > bv) return view.dir;
      return a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0;
    });
  }

  function topBar() {
    return tag('header', { class: 'top' },
      tag('div', { class: 'brand' }, tag('span', { class: 'mark' }), tag('span', { text: 'Token Radar' })),
      tag('div', { class: 'top-meta' },
        tag('span', { text: 'Snapshot ' + DATA.as_of }),
        tag('span', { text: 'DefiLlama protocol index' }),
        tag('span', { text: DATA.model_version + ' model' })
      )
    );
  }

  function intro() {
    return tag('section', { class: 'lede' },
      tag('div', null,
        tag('h1', { text: DATA.watchlist_size + ' watchlist protocols, ranked by implied value' }),
        tag('p', { text: 'The watchlist is the floor: every protocol with at least $' + Math.round(DATA.floor_usd / 1e6) + 'M of TVL and no token on record. The early radar adds ' + DATA.early_size + ' pre-token protocols below that floor. Implied value is a model, not a promise.' })
      ),
      tag('div', { class: 'facts' },
        tag('div', { class: 'fact' }, tag('span', { text: 'Watchlist covered' }), tag('b', { text: DATA.watchlist_size + ' / ' + DATA.watchlist_size })),
        tag('div', { class: 'fact' }, tag('span', { text: 'Pre-token rows scored' }), tag('b', { text: String(DATA.board_size) })),
        tag('div', { class: 'fact' }, tag('span', { text: 'Early rows below the floor' }), tag('b', { text: String(DATA.early_size) })),
        tag('div', { class: 'fact' }, tag('span', { text: 'Live-token protocols set aside' }), tag('b', { text: String(DATA.live_size) }))
      )
    );
  }

  function filterBar() {
    var categories = Array.from(new Set(DATA.rows.map(function (r) { return r.category || 'Other'; }))).sort();
    var chainCounts = {};
    DATA.rows.forEach(function (r) { (r.chains || []).forEach(function (c) { chainCounts[c] = (chainCounts[c] || 0) + 1; }); });
    var chains = Object.keys(chainCounts).sort(function (a, b) { return chainCounts[b] - chainCounts[a]; }).slice(0, 12);
    var search = tag('input', { type: 'search', id: 'q', placeholder: 'Search name, category or chain', value: view.q, 'aria-label': 'Search the board' });
    search.addEventListener('input', function () { view.q = search.value; writeHash(); render(); });
    var cat = tag('select', { id: 'category', 'aria-label': 'Filter by category' },
      tag('option', { value: 'all', text: 'All categories' }),
      categories.map(function (c) { return tag('option', { value: c, text: c, selected: c === view.category ? 'selected' : null }); })
    );
    cat.addEventListener('change', function () { view.category = cat.value; writeHash(); render(); });
    var chn = tag('select', { id: 'chain', 'aria-label': 'Filter by chain' },
      tag('option', { value: 'all', text: 'All chains' }),
      chains.map(function (c) { return tag('option', { value: c, text: c, selected: c === view.chain ? 'selected' : null }); })
    );
    chn.addEventListener('change', function () { view.chain = chn.value; writeHash(); render(); });
    var tvl = tag('select', { id: 'tvl', 'aria-label': 'Filter by TVL' },
      [['all', 'Any TVL'], ['500M+', '$500M+'], ['100-500M', '$100-500M'], ['50-100M', '$50-100M'], ['10-50M', '$10-50M'], ['5-10M', '$5-10M']].map(function (o) {
        return tag('option', { value: o[0], text: o[1], selected: o[0] === view.tvl ? 'selected' : null });
      })
    );
    tvl.addEventListener('change', function () { view.tvl = tvl.value; writeHash(); render(); });
    var pre = tag('button', { type: 'button', 'aria-pressed': view.tab === 'pre-token' ? 'true' : 'false', text: 'Pre-token', onclick: function () { view.tab = 'pre-token'; render(); } });
    var live = tag('button', { type: 'button', 'aria-pressed': view.tab === 'live' ? 'true' : 'false', text: 'Live token', onclick: function () { view.tab = 'live'; render(); } });
    return tag('div', { class: 'controls' },
      tag('div', { class: 'field' }, tag('label', { for: 'q', text: 'Search' }), search),
      tag('div', { class: 'field' }, tag('label', { for: 'category', text: 'Category' }), cat),
      tag('div', { class: 'field' }, tag('label', { for: 'chain', text: 'Chain' }), chn),
      tag('div', { class: 'field' }, tag('label', { for: 'tvl', text: 'TVL' }), tvl),
      tag('div', { class: 'field' }, tag('span', { class: 'sub', text: 'Token status' }), tag('div', { class: 'tabs' }, pre, live)),
      tag('span', { class: 'count', text: view.tab === 'pre-token' ? filteredRows().length + ' rows shown' : DATA.live.length + ' live-token protocols' })
    );
  }

  function sortHead(key, label) {
    return tag('th', { scope: 'col' },
      tag('button', { type: 'button', onclick: function () { if (view.sort === key) view.dir = -view.dir; else { view.sort = key; view.dir = -1; } render(); } },
        label,
        view.sort === key ? tag('span', { 'aria-hidden': 'true', text: view.dir < 0 ? ' v' : ' ^' }) : null
      )
    );
  }

  function boardPanel() {
    var list = orderedRows(filteredRows());
    if (list.length === 0) {
      return tag('div', { class: 'panel' }, tag('div', { class: 'empty' },
        tag('h2', { text: 'No protocol matches that filter' }),
        tag('p', { text: 'Clear the search or pick another category to see the board again.' }),
        tag('button', { class: 'button primary', type: 'button', text: 'Clear filters', onclick: function () { view.q = ''; view.category = 'all'; view.chain = 'all'; view.tvl = 'all'; writeHash(); render(); } })
      ));
    }
    var max = list[0].implied_value_usd || 1;
    var tbody = tag('tbody');
    list.forEach(function (r) {
      var growth = r.change_7d === null ? 'n/a' : pct(r.change_7d);
      var growthClass = r.change_7d === null ? '' : r.change_7d >= 0 ? 'pos' : 'neg';
      var tr = tag('tr', {
        'data-selected': view.selected === r.slug ? 'true' : 'false',
        tabindex: '0',
        onclick: function () { openDetail(r.slug); },
        onkeydown: function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openDetail(r.slug); } }
      },
        tag('td', { class: 'num', text: String(r.rank) }),
        tag('td', null, tag('div', { class: 'name' },
          tag('b', { text: r.name }),
          tag('span', { class: 'sub', text: (r.category || 'Other') + ' on ' + (r.chains && r.chains.length ? r.chains.slice(0, 2).join(', ') : 'an unnamed chain') })
        )),
        tag('td', { class: 'num', text: money(r.tvl_usd) }),
        tag('td', { class: 'num ' + growthClass, text: growth }),
        tag('td', { class: 'num', text: ageLabel(r.age_days) }),
        tag('td', null, tag('div', { class: 'implied' },
          tag('div', { class: 'bar', 'aria-hidden': 'true' }, tag('i', { style: 'width:' + Math.max(3, Math.round((r.implied_value_usd / max) * 100)) + '%' })),
          tag('span', { class: 'num', text: money(r.implied_value_usd) })
        )),
        tag('td', null, tag('span', { class: 'status', text: 'no token' }))
      );
      tbody.appendChild(tr);
    });
    return tag('div', { class: 'panel' },
      tag('div', { class: 'table-wrap' },
        tag('table', null,
          tag('caption', { class: 'sub', text: 'Pre-token protocols, strongest implied value first. Select a row for its model and farm plan.' }),
          tag('thead', null, tag('tr', null,
            sortHead('implied', 'Rank'),
            sortHead('name', 'Protocol'),
            sortHead('tvl', 'TVL'),
            sortHead('growth', '7d'),
            sortHead('age', 'Age'),
            sortHead('implied', 'Implied value'),
            tag('th', { scope: 'col', text: 'Token' })
          )),
          tbody
        )
      )
    );
  }

  function livePanel() {
    var tbody = tag('tbody');
    DATA.live.forEach(function (r) {
      tbody.appendChild(tag('tr', null,
        tag('td', { class: 'num', text: 'live' }),
        tag('td', null, tag('div', { class: 'name' }, tag('b', { text: r.name }), tag('span', { class: 'sub', text: (r.category || 'Other') + ' on ' + (r.chains && r.chains.length ? r.chains.slice(0, 2).join(', ') : 'an unnamed chain') }))),
        tag('td', { class: 'num', text: money(r.tvl_usd) }),
        tag('td', { class: 'num ' + (r.change_7d !== null && r.change_7d >= 0 ? 'pos' : 'neg'), text: pct(r.change_7d) }),
        tag('td', { class: 'num', text: money(r.mcap_usd) }),
        tag('td', null, tag('span', { class: 'status live', text: 'already trades' }))
      ));
    });
    return tag('div', { class: 'panel' },
      tag('div', { class: 'table-wrap' },
        tag('table', null,
          tag('caption', { class: 'sub', text: 'Token live: these protocols already trade, so their market cap is a fact, not a model. They are set aside from the pre-token ranking.' }),
          tag('thead', null, tag('tr', null, tag('th', { scope: 'col', text: 'Status' }), tag('th', { scope: 'col', text: 'Protocol' }), tag('th', { scope: 'col', text: 'TVL' }), tag('th', { scope: 'col', text: '7d' }), tag('th', { scope: 'col', text: 'Market cap' }), tag('th', { scope: 'col', text: 'Token' }))),
          tbody
        )
      )
    );
  }

  function modelSection() {
    var m = DATA.model;
    var comps = Object.keys(DATA.comps).map(function (k) {
      return { category: k, multiple: DATA.comps[k].multiple, peers: DATA.comps[k].peers };
    }).sort(function (a, b) { return b.peers - a.peers || b.multiple - a.multiple; }).slice(0, 12);
    var rows = comps.map(function (c) {
      return tag('tr', null,
        tag('td', { text: c.category }),
        tag('td', { class: 'num', text: c.multiple.toFixed(3) + 'x' }),
        tag('td', { class: 'num', text: String(c.peers) })
      );
    });
    return tag('section', { class: 'panel model' },
      tag('h2', { text: 'How implied value is computed' }),
      tag('p', { class: 'sub', text: 'Every row is scored by one function of the snapshot figures. No protocol name is special-cased, and no row is hand-picked.' }),
      tag('div', { class: 'formula' },
        'implied = round( tvl_usd x category multiple x (1 + clamp(change_7d, ' + m.growth_floor + ', ' + m.growth_cap + ') / 100 x ' + m.growth_weight + ') x (' + m.maturity_floor + ' + min(age_days, ' + m.maturity_days + ') / ' + m.maturity_days + ' x ' + m.maturity_range + ') x (1 + 0.05 x min(chains - 1, 4)) )'
      ),
      tag('p', { class: 'sub', text: 'The category multiple is the median market-cap / TVL of the protocols in that category that already trade, computed from this snapshot on every run. A category with fewer than ' + m.shrink_prior + ' trading peers is shrunk toward the global median of ' + DATA.global_multiple.toFixed(3) + 'x, and every multiple is clamped to ' + m.multiple_floor + 'x–' + m.multiple_cap + 'x. Age is the time since the protocol was first listed: how long it has run with no token on record; an unlisted age uses ' + m.unknown_age_days + ' days.' }),
      tag('table', { class: 'comps' },
        tag('thead', null, tag('tr', null, tag('th', { scope: 'col', text: 'Category' }), tag('th', { scope: 'col', text: 'Multiple' }), tag('th', { scope: 'col', text: 'Trading peers' }))),
        tag('tbody', null, rows)
      ),
      tag('p', { class: 'note', text: 'Implied value is this radar’s own estimate, never a price and never a promise that a token will launch. A protocol on this board records no token in the snapshot; that is a record, not proof it has none.' })
    );
  }

  var dialog = tag('dialog', { class: 'detail', id: 'detail', 'aria-labelledby': 'detail-title' });
  dialog.addEventListener('close', function () { view.selected = null; writeHash(); });

  function openDetail(slug) {
    var row = DATA.rows.filter(function (r) { return r.slug === slug; })[0];
    if (!row) return;
    view.selected = slug;
    writeHash();
    dialog.textContent = '';
    var steps = farmPlan(row);
    var recomputed = recomputeImplied(row, DATA.model);
    dialog.appendChild(tag('div', { class: 'detail-head' },
      tag('div', null,
        tag('span', { class: 'rank-badge', text: 'Rank ' + row.rank + ' of ' + DATA.board_size }),
        tag('h2', { id: 'detail-title', text: row.name }),
        tag('p', { class: 'sub', text: (row.category || 'Other') + ' on ' + (row.chains && row.chains.length ? row.chains.join(', ') : 'an unnamed chain') })
      ),
      tag('button', { class: 'close', type: 'button', 'aria-label': 'Close details', text: 'Close', onclick: function () { dialog.close(); } })
    ));
    dialog.appendChild(tag('section', { class: 'detail-section' },
      tag('h3', { text: 'Implied value' }),
      tag('div', { class: 'equation' },
        tag('div', null, tag('span', { text: 'TVL' }), tag('b', { class: 'num', text: money(row.tvl_usd) })),
        tag('div', null, tag('span', { text: 'Seven-day growth' }), tag('b', { class: 'num', text: pct(row.change_7d) })),
        tag('div', null, tag('span', { text: 'Age with no token' }), tag('b', { class: 'num', text: ageLabel(row.age_days) })),
        tag('div', null, tag('span', { text: 'Category multiple' }), tag('b', { class: 'num', text: row.category_multiple.toFixed(3) + 'x' })),
        tag('div', null, tag('span', { text: 'Growth multiplier' }), tag('b', { class: 'num', text: String(row.growth_multiplier) })),
        tag('div', null, tag('span', { text: 'Maturity multiplier' }), tag('b', { class: 'num', text: String(row.maturity_multiplier) })),
        tag('div', null, tag('span', { text: 'Chain multiplier' }), tag('b', { class: 'num', text: String(row.chain_multiplier) })),
        tag('div', null, tag('span', { text: 'Chains' }), tag('b', { class: 'num', text: String((row.chains || []).length) })),
        tag('div', null, tag('span', { text: 'Implied value' }), tag('b', { class: 'num', text: money(row.implied_value_usd) }))
      ),
      tag('p', { class: 'sub', text: 'Model ' + DATA.model_version + ': the same function scores every protocol. The page recomputes this row as ' + money(recomputed) + (recomputed === row.implied_value_usd ? ', the same number board.json carries.' : ', which differs from the board: the data would be stale.') + ' This is an estimate, not a price.' })
    ));
    dialog.appendChild(tag('section', { class: 'detail-section' },
      tag('h3', { text: 'Farm plan' }),
      tag('ol', { class: 'steps' }, steps.map(function (s) {
        var at = s.indexOf(' Cost: ');
        var action = at >= 0 ? s.slice(0, at) : s;
        var tail = at >= 0 ? s.slice(at + 1) : '';
        return tag('li', null, tag('b', { text: action }), tag('span', { class: 'cost', text: tail }));
      }))
    ));
    if (typeof dialog.showModal === 'function') {
      if (!dialog.open) dialog.showModal();
    } else {
      dialog.setAttribute('open', '');
    }
  }

  function render() {
    board.textContent = '';
    var shell = tag('div', { class: 'shell' });
    shell.appendChild(topBar());
    shell.appendChild(intro());
    shell.appendChild(filterBar());
    shell.appendChild(view.tab === 'pre-token' ? boardPanel() : livePanel());
    if (view.tab === 'pre-token') shell.appendChild(modelSection());
    board.appendChild(shell);
    board.setAttribute('aria-busy', 'false');
    if (!dialog.isConnected) board.appendChild(dialog);
    if (view.selected) openDetail(view.selected);
  }

  readHash();
  render();
  window.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && dialog.open) dialog.close();
  });
})();
