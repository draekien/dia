const ICONS = {
  download:
    '<path d="M12 15V3"/><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5"/>',
  alert:
    '<circle cx="12" cy="12" r="10"/><line x1="12" x2="12" y1="8" y2="12"/><line x1="12" x2="12.01" y1="16" y2="16"/>',
  ellipsis:
    '<circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/><circle cx="5" cy="12" r="1"/>'
}
const svg = (name) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${ICONS[name]}</svg>`

const ENTRIES = [
  {
    id: 'version',
    side: 'start',
    order: 20,
    cls: '',
    html: '<span class="label mono">v0.42.0</span>',
    menu: '<span class="mono">v0.42.0</span>'
  },
  {
    id: 'update',
    side: 'start',
    order: 10,
    cls: 'update',
    icon: 'download',
    html: '<span class="label">Restart to update</span>',
    menu: 'Restart to update'
  },
  {
    id: 'errors',
    side: 'end',
    order: 0,
    cls: 'error',
    icon: 'alert',
    html: '<span class="label">2 plugins failed to load</span>',
    menu: '2 plugins failed to load'
  }
]

function entryEl(entry, opt) {
  const el = document.createElement('span')
  el.className = `entry ${entry.cls} ${opt.overflow === 'truncate' && entry.id !== 'version' ? 'shrink' : ''}`
  el.dataset.order = entry.order
  el.innerHTML = (entry.icon ? svg(entry.icon) : '') + entry.html
  return el
}

function barEl(opt, state) {
  const bar = document.createElement('div')
  bar.className = `bar ${opt.flat ? 'flat' : ''}`
  bar.style.height = `${opt.height}px`
  const start = document.createElement('div')
  start.className = 'group start'
  const end = document.createElement('div')
  end.className = 'group end'
  for (const entry of ENTRIES) {
    const group = entry.side === 'start' ? start : end
    if (opt.separator === 'rule' && group.children.length > 0) {
      const sep = document.createElement('span')
      sep.className = 'sep'
      group.append(sep)
    }
    const el = entryEl(entry, opt)
    if (state.focus === entry.id) el.classList.add('focus')
    group.append(el)
  }
  bar.append(start, end)
  return bar
}

function windowEl(opt, state) {
  const win = document.createElement('div')
  win.className = `win ${state.dark ? 'dark' : ''}`
  win.style.width = `${state.width}px`
  const cols = document.createElement('div')
  cols.className = 'cols'
  cols.innerHTML = state.collapsed
    ? `
    <div class="sidebar rail"><span class="dot half"></span><span class="dot"></span></div>
    <div class="content">
      <div class="transcript">The bar sits under the composer.</div>
      <div class="composer">Ask for follow-up changes</div>
    </div>`
    : `
    <div class="sidebar">
      <div class="thread sel"><span class="dot half"></span><span><b>task-bar-design</b><small>Edit docs/designs/task-bar.md</small></span></div>
      <div class="thread"><span class="dot"></span><span><b>brave-otter</b><small>pnpm typecheck</small></span></div>
    </div>
    <div class="content">
      <div class="transcript">The bar sits under the composer.</div>
      <div class="composer">Ask for follow-up changes</div>
    </div>`
  win.append(cols)
  if (state.empty) return win
  const bar = barEl(opt, state)
  if (opt.placement === 'content') cols.querySelector('.content').append(bar)
  else win.append(bar)
  return win
}

function fitOverflow(frame, opt, state) {
  const bar = frame.querySelector('.bar')
  if (!bar) return
  const fits = () => bar.scrollWidth <= bar.clientWidth
  const hidden = []
  let more
  while (!fits()) {
    const visible = [...bar.querySelectorAll('.entry:not(.more)')].filter(
      (el) => el.style.display !== 'none'
    )
    if (visible.length === 0) break
    const victim = visible.reduce((a, b) =>
      Number(b.dataset.order) > Number(a.dataset.order) ? b : a
    )
    victim.style.display = 'none'
    const sep = victim.previousElementSibling?.classList.contains('sep')
      ? victim.previousElementSibling
      : victim.nextElementSibling
    if (sep?.classList.contains('sep')) sep.style.display = 'none'
    hidden.push(ENTRIES.find((entry) => String(entry.order) === victim.dataset.order))
    if (opt.overflow === 'menu' && !more) {
      more = document.createElement('span')
      more.className = 'entry more'
      more.innerHTML = svg('ellipsis')
      bar.querySelector('.start').append(more)
    }
  }
  if (more && state.menuOpen) {
    more.classList.add('hover')
    const menu = document.createElement('div')
    menu.className = `menu ${state.dark ? 'dark' : ''}`
    menu.innerHTML = hidden
      .sort((a, b) => a.order - b.order)
      .map((entry) => `<div>${entry.icon ? svg(entry.icon) : '<svg></svg>'}${entry.menu}</div>`)
      .join('')
    frame.append(menu)
    const f = frame.getBoundingClientRect()
    const m = more.getBoundingClientRect()
    const w = frame.querySelector('.win').getBoundingClientRect()
    menu.style.left = `${Math.min(m.left, w.right - menu.offsetWidth - 4) - f.left}px`
    menu.style.top = `${m.top - f.top - menu.offsetHeight - 4}px`
  }
}

function render(opt) {
  document.title = opt.title
  document.body.innerHTML = `<div><h1>${opt.title}</h1><p class="spec">${opt.spec}</p></div>`
  const frames = [
    { caption: 'Light, 1072px window, all three sample entries', width: 1072 },
    {
      caption: 'Dark, keyboard focus on the update entry',
      width: 1072,
      dark: true,
      focus: 'update'
    },
    {
      caption:
        opt.overflow === 'menu'
          ? 'Light, 340px window, sidebar collapsed: entries that do not fit move into the overflow menu (shown open)'
          : 'Light, 340px window, sidebar collapsed: labels truncate, then entries hide',
      width: 340,
      collapsed: true,
      menuOpen: true
    },
    { caption: 'Light, no entries: the bar is not drawn', width: 1072, empty: true }
  ]
  for (const state of frames) {
    const frame = document.createElement('div')
    frame.className = 'frame'
    frame.innerHTML = `<p class="caption">${state.caption}</p>`
    frame.append(windowEl(opt, state))
    document.body.append(frame)
    fitOverflow(frame, opt, state)
  }
}
