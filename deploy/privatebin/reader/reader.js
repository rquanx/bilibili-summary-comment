/* Upstream owns encryption, storage and decryption. */
(() => {
 const $ = id => document.getElementById(id);
 const choice = $('readerchoice'), room = $('reading-room'), source = $('prettyprint');
 let selected = 'reader', rendered = null, original = '', size = 17;
 const mode = () => new URLSearchParams(location.hash.split('&').slice(1).join('&')).get('view');
 window.PrivateBinReader = { shareSuffix: () => `&view=${selected}` };
 const visible = el => el && !el.classList.contains('hidden');
 function update() {
  const editing = visible($('editorTabs'));
  if (choice.hidden === editing) choice.hidden = !editing;
  const active = mode() === 'reader' && visible($('prettymessage')) && !editing && !!source.textContent;
  document.body.classList.toggle('reader-active', active); room.hidden = !active;
  const settled = active || editing || visible($('plaintext')) || visible($('errormessage')) || mode() !== 'reader';
  if (settled) document.documentElement.classList.remove('reader-pending');
  if (!active || rendered === source.textContent) return;
  original = rendered = source.textContent;
  const content = document.createDocumentFragment();
  for (const line of original.split(/\r?\n/)) {
   const marker = line.trim().match(/^<(\d+)P>$/);
   const match = line.match(/^\d+#(\d{1,2}:\d{2}(?::\d{2})?)\s+(.*)$/);
   const row = document.createElement(marker ? 'h2' : match ? 'section' : 'p');
   if (marker) row.textContent = `P${marker[1]}`;
   else if (match) {
    row.className = 'reader-entry';
    const time = document.createElement('span'), paragraph = document.createElement('p');
    time.className = 'reader-time'; time.textContent = match[1]; paragraph.textContent = match[2];
    row.append(time, paragraph);
   } else { row.className = 'reader-paragraph'; row.textContent = line || '\u00a0'; }
   content.append(row);
  }
  $('readercontent').replaceChildren(content);
 }
 choice.onclick = () => {
  selected = selected === 'reader' ? 'original' : 'reader';
  choice.textContent = `阅读页：${selected === 'reader' ? '新版' : '原始'}`;
  choice.setAttribute('aria-pressed', String(selected === 'reader'));
 };
 $('copy').onclick = async () => {
  const status = $('reader-toast');
  try { await navigator.clipboard.writeText(original); status.textContent = '已复制'; }
  catch { status.textContent = '复制失败，请选择正文复制'; }
  clearTimeout(window.PrivateBinReader.toastTimer);
  window.PrivateBinReader.toastTimer = setTimeout(() => { status.textContent = ''; }, 1800);
 };
 const resize = delta => { size = Math.max(14, Math.min(24, size + delta)); room.style.setProperty('--reader-size', `${size}px`); };
 $('smaller').onclick = () => resize(-1); $('larger').onclick = () => resize(1);
 // MutationObserver batches synchronous upstream changes before the next paint.
 // Waiting for requestAnimationFrame here could paint the official view first.
 const observer = new MutationObserver(update);
 for (const el of [$('prettymessage'), $('editorTabs'), $('plaintext'), $('errormessage')]) observer.observe(el, { attributes: true, childList: true, characterData: true, subtree: true });
 addEventListener('hashchange', update); update();
})();
