// icons.js - the icons of the editor: the free Line Awesome font by Icons8, its solid style
// (css/lineawesome.css, fonts/la-solid-900.*).
//
// The editor names its icons by what they mean (the names of Material Symbols, which it used
// before); ICONS gives the glyph of Line Awesome that fits best. A value is the name of the glyph,
// optionally followed by how it is turned: 'flip-x', 'flip-y', 'rotate-45', 'rotate-90',
// 'rotate-180', 'rotate-270', or 'off' (struck through). The names that begin with 'shape-' are not
// in the font: m3.css draws them (an arc, a full box and dot for the brushes and the location
// arrows of the object tools, outline and full).

export const ICONS = {
  // nerdsuite: the code editor and the debugger
  play: 'play', pause: 'pause', stop: 'stop', step_into: 'level-down-alt', step_over: 'redo-alt', step_out: 'sign-out-alt',
  run_to: 'arrow-right', debug: 'bug', memory: 'memory', cpu: 'microchip', terminal: 'terminal', code_file: 'file-code',
  power: 'power-off', monitor: 'desktop', disk: 'hdd', watch: 'eye', flag: 'flag', list: 'list', hammer: 'hammer',
  folder: 'folder-open', sort: 'sort-numeric-down', label: 'tag', add_box: 'plus-square', hashtag: 'hashtag', wizard: 'magic',
  // general
  add: 'plus', remove: 'minus', horizontal_rule: 'minus', close: 'times', clear: 'times', check: 'check',
  check_circle: 'check-circle', task_alt: 'check-circle', error: 'times-circle', warning: 'exclamation-triangle', report: 'bug',
  info: 'info-circle', block: 'ban', search: 'search', zoom_in: 'search-plus', zoom_out: 'search-minus',
  menu: 'bars', more_horiz: 'ellipsis-h', more_vert: 'ellipsis-v',
  tune: 'sliders-h', switch: 'toggle-on', toggle_on: 'toggle-on',
  build: 'hammer', handyman: 'tools', rocket_launch: 'rocket', bolt: 'bolt',
  dark_mode: 'moon', light_mode: 'sun', light: 'sun', highlight: 'lightbulb',
  lock: 'lock', lock_open: 'lock-open', password: 'key', link: 'link', link_off: 'unlink',
  visibility: 'eye', visibility_off: 'eye-slash', hide: 'eye-slash',
  language: 'globe', public: 'globe', travel_explore: 'home', wifi_find: 'wifi',
  history: 'history', restore: 'history', push_pin: 'thumbtack', hourglass_empty: 'hourglass-half', speed: 'tachometer-alt', print: 'print',

  // arrows
  arrow_upward: 'arrow-up', arrow_downward: 'arrow-down', arrow_forward: 'arrow-right',
  north: 'arrow-up', south: 'arrow-down', east: 'arrow-right', west: 'arrow-left', north_east: 'long-arrow-alt-up rotate-45',
  open_in_new: 'external-link-alt', chevron_left: 'angle-left', chevron_right: 'angle-right',
  expand_more: 'angle-down', expand_less: 'angle-up', arrow_drop_down: 'caret-down', unfold_less: 'angle-up', unfold_more: 'angle-down',
  swap_horiz: 'exchange-alt', width: 'arrows-alt-h',
  swap_vert: 'exchange-alt rotate-90', height: 'arrows-alt-v',
  navigation: 'shape-arrow', near_me: 'shape-arrow-full', open_with: 'arrows-alt', move: 'arrows-alt', resize: 'expand-arrows-alt', fullscreen: 'expand-arrows-alt',
  fit_screen: 'expand', right_panel_close: 'angle-double-right', right_panel_open: 'angle-double-left',
  undo: 'undo', redo: 'redo', refresh: 'sync-alt', restart_alt: 'undo-alt',
  replay: 'undo-alt', loop: 'sync', repeat: 'redo-alt',
  repeat_one: 'circle-notch', rotate_right: 'redo-alt', rotate_left: 'undo-alt',
  subdirectory_arrow_right: 'level-up-alt rotate-90', keyboard_return: 'level-down-alt rotate-90', backspace: 'backspace',

  // files and editing
  save: 'save', save_as: 'file-export', description: 'file-alt', note_add: 'plus-square', upload_file: 'file-upload',
  drive_file_move: 'folder', folder_open: 'folder-open', download: 'download', archive: 'file-archive', unarchive: 'upload', lightbulb: 'lightbulb', folder_off: 'folder-minus', content_copy: 'copy', content_paste: 'paste', content_cut: 'cut',
  delete: 'trash-alt', delete_sweep: 'eraser', sweep: 'broom', edit: 'pen', draw: 'pencil-alt', edit_note: 'edit',
  code: 'code', source: 'code', data_object: 'file-code', function: 'terminal', label: 'bookmark', class: 'bookmark', tag: 'tag',
  text_fields: 'font', title: 'heading', playlist_add: 'plus-circle', add_to_photos: 'images',
  select_all: 'check-double', select: 'mouse-pointer', highlight_alt: 'object-group',

  // drawing
  brush: 'paint-brush', format_paint: 'paint-roller', format_color_fill: 'fill-drip', colorize: 'eye-dropper',
  colors: 'palette', style: 'palette', invert_colors: 'tint', auto_fix_high: 'magic',
  flip: 'exchange-alt', blur_on: 'spray-can', grain: 'braille', crop_square: 'stop', check_box: 'check-square', check_box_outline_blank: 'stop', radio_button_unchecked: 'circle', circle: 'circle', brush_square: 'shape-box-full', brush_circle: 'shape-dot',
  looks: 'shape-arc', pentagon: 'draw-polygon', grid_on: 'th', table: 'table', pattern: 'th', grid_view: 'th-large',
  view_agenda: 'stream', wallpaper: 'image', animation: 'film', stack: 'layer-group', my_location: 'crosshairs', target: 'bullseye',

  // the story
  sports_esports: 'gamepad', joystick: 'gamepad', keyboard: 'keyboard', mouse: 'mouse',
  account_tree: 'sitemap', conversion_path: 'route', alt_route: 'route', call_split: 'code-branch', rule: 'tasks',
  auto_stories: 'book-open', menu_book: 'book', flag: 'flag', start: 'flag', outro: 'flag-checkered',
  meeting_room: 'door-open', door_open: 'door-open', door_front: 'door-closed', login: 'sign-in-alt', logout: 'sign-out-alt', input: 'sign-in-alt', room: 'home', add_home: 'home',
  map: 'map', location_on: 'map-marker-alt', place: 'map-marker-alt', pin_drop: 'map-pin', add_location_alt: 'map-marked-alt',
  person: 'user', person_add: 'user-plus', face: 'smile', group: 'users', groups: 'users',
  switch_account: 'user-friends', person_pin_circle: 'street-view', theater_comedy: 'theater-masks',
  checkroom: 'tshirt', checkplace: 'tshirt', directions_walk: 'walking', directions_run: 'running',
  category: 'shapes', inventory: 'box-open', place_item: 'box', move_item: 'dolly',
  backpack: 'briefcase', redeem: 'gift', back_hand: 'hand-paper', front_hand: 'hand-paper', pan_tool: 'hand-paper',
  ads_click: 'mouse-pointer', chat: 'comment-dots', comment: 'comment', add_comment: 'comment-medical', forum: 'comments',
  message: 'comment-alt', speaker_notes_off: 'comment-slash', dialpad: 'calculator', pin: 'hashtag',
  camera: 'camera', videocam: 'video', movie: 'film', step: 'shoe-prints', steps: 'shoe-prints',

  // sound
  play_arrow: 'play', play_circle: 'play-circle', pause: 'pause', stop: 'stop', stop_circle: 'stop-circle',
  music_note: 'music', piano: 'drum', radio: 'broadcast-tower', volume_up: 'volume-up', volume_off: 'volume-mute', call: 'phone',
  // an instrument's sync (its oscillator tied to the voice before) and ring modulation (bells)
  wave_sync: 'link', wave_ring: 'concierge-bell',

  // the tags of the text sequences (seqtags.js)
  vertical_align_top: 'level-up-alt', format_color_text: 'font', border_outer: 'border-all', flare: 'star',
  clear_all: 'eraser', keyboard_tab: 'indent', format_align_center: 'align-center', format_align_left: 'align-left',
  format_align_right: 'align-right', expand: 'arrows-alt-v', pause_circle: 'pause-circle', slideshow: 'play-circle',
};

// the classes of an icon, for an element of class 'msr'
export function iconClass(name) {
  const [glyph, ...turns] = (ICONS[name] ?? 'question').split(' ');
  return ['la', `la-${glyph}`, ...turns.map(t => `icon--${t}`)].join(' ');
}

// another icon on an element that shows one
export function setIcon(el, name) {
  if (!el) return;
  el.className = [...el.classList].filter(c => !/^(la|icon)(-|$)/.test(c)).concat(iconClass(name)).join(' ');
}
