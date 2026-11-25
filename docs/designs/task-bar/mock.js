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
  { id: 'version', side: 'start', order: 20, label: 'v0.42.0', mono: true },
  {
    id: 'update',
    side: 'start',
    order: 10,
    icon: 'download',
    label: 'Restart to update',
    shrink: true
  },
  {
    id: 'errors',
    side: 'end',
    order: 0,
    icon: 'alert',
    label: '2 plugins failed to load',
    shrink: true
  }
]

const labelHtml = (entry, cls) =>
  `<span class="${cls}${entry.mono ? ' mono' : ''}">${entry.label}</span>`

function entryEl(entry, opt) {
  const el = document.createElement('span')
  el.classList.add('entry', entry.id)
  el.classList.toggle('shrink', opt.overflow === 'truncate' && entry.shrink === true)
  el.dataset.id = entry.id
  el.innerHTML = (entry.icon ? svg(entry.icon) : '') + labelHtml(entry, 'label')
  return el
}

function barEl(opt, state) {
  const bar = document.createElement('div')
  bar.classList.add('bar')
  bar.classList.toggle('flat', opt.flat === true)
  bar.classList.toggle('rule', opt.separator === 'rule')
  bar.style.height = `${opt.height}px`
  const start = document.createElement('div')
  start.className = 'group start'
  const end = document.createElement('div')
  end.className = 'group end'
  for (const entry of ENTRIES) {
    const el = entryEl(entry, opt)
    el.classList.toggle('focus', state.focus === entry.id)
    ;(entry.side === 'start' ? start : end).append(el)
  }
  bar.append(start, end)
  return bar
}

function windowEl(opt, state) {
  const win = document.createElement('div')
  win.classList.add('win')
  win.classList.toggle('dark', state.dark === true)
  win.style.width = `${state.width}px`
  const cols = document.createElement('div')
  cols.className = 'cols'
  const sidebar = state.collapsed
    ? '<div class="sidebar rail"><span class="dot half"></span><span class="dot"></span></div>'
    : `<div class="sidebar">
      <div class="thread sel"><span class="dot half"></span><span><b>task-bar-design</b><small>Edit docs/designs/task-bar.md</small></span></div>
      <div class="thread"><span class="dot"></span><span><b>brave-otter</b><small>pnpm typecheck</small></span></div>
    </div>`
  cols.innerHTML = `${sidebar}
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
    const visible = ENTRIES.filter((entry) => !hidden.includes(entry))
    if (visible.length === 0) break
    const victim = visible.reduce((a, b) => (b.order > a.order ? b : a))
    bar.querySelector(`[data-id="${victim.id}"]`).hidden = true
    hidden.push(victim)
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
    menu.classList.add('menu')
    menu.classList.toggle('dark', state.dark === true)
    menu.innerHTML = hidden
      .sort((a, b) => a.order - b.order)
      .map(
        (entry) =>
          `<div>${entry.icon ? svg(entry.icon) : '<svg></svg>'}${labelHtml(entry, '')}</div>`
      )
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

window.render = render
