const $ = (id) => document.getElementById(id);
let original = "";
let fontSize = 17;
function notify(message) { $("toast").textContent = message; $("toast").classList.add("show"); clearTimeout(notify.timer); notify.timer = setTimeout(() => $("toast").classList.remove("show"), 2300); }
function decodeBase58(text) {
  const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let value = 0n;
  for (const ch of text) { const n = alphabet.indexOf(ch); if (n < 0) throw Error("分享链接的密钥不完整"); value = value * 58n + BigInt(n); }
  let hex = value.toString(16).padStart(64, "0");
  if (hex.length !== 64) throw Error("分享链接的密钥长度不正确");
  return Uint8Array.from(hex.match(/../g), b => parseInt(b, 16));
}
const from64 = (s) => Uint8Array.from(atob(s), c => c.charCodeAt(0));
async function openPaste() {
  try {
    const keyText = location.hash.replace(/^#-?/, "");
    if (!keyText) throw Error("这份文字需要完整的分享链接才能打开");
    const payload = await (await fetch("/api/paste")).json();
    const [spec] = payload.adata;
    const raw = await crypto.subtle.importKey("raw", decodeBase58(keyText), "PBKDF2", false, ["deriveKey"]);
    const key = await crypto.subtle.deriveKey({ name: "PBKDF2", hash: "SHA-256", salt: from64(spec[1]), iterations: spec[2] }, raw, { name: "AES-GCM", length: spec[3] }, false, ["decrypt"]);
    const buffer = await crypto.subtle.decrypt({ name: "AES-GCM", iv: from64(spec[0]), additionalData: new TextEncoder().encode(JSON.stringify(payload.adata)), tagLength: spec[4] }, key, from64(payload.ct));
    original = JSON.parse(new TextDecoder().decode(buffer)).paste;
    render(original);
  } catch (error) {
    $("content").replaceChildren();
    const message = document.createElement("p"); message.className = "loading";
    message.textContent = "暂时无法打开这份文字。请确认链接完整，包含 # 后的全部内容。";
    $("content").append(message);
    $("wordcount").textContent = "解密未完成";
    $("readtime").textContent = "请检查分享链接";
  }
}
function render(text) {
  const fragment = document.createDocumentFragment();
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim() || /^<\d+P>$/.test(line.trim())) continue;
    const matched = line.match(/^\d+#(\d{1,2}:\d{2}(?::\d{2})?)\s+(.*)$/);
    if (matched) {
      const row = document.createElement("section"); row.className = "entry";
      const time = document.createElement("span"); time.className = "timestamp"; time.textContent = matched[1];
      const p = document.createElement("p"); p.textContent = matched[2]; row.append(time, p); fragment.append(row);
    } else { const p = document.createElement("p"); p.className = "paragraph"; p.textContent = line; fragment.append(p); }
  }
  $("content").replaceChildren(fragment);
  $("wordcount").textContent = `${text.replace(/\s/g, "").length.toLocaleString("zh-CN")} 字`;
  $("readtime").textContent = `约 ${Math.max(1, Math.ceil(text.length / 350))} 分钟阅读`;
}
$("copy").onclick = async () => { try { if (!original) return notify("文字尚未打开"); await navigator.clipboard.writeText(original); notify("全文已复制"); } catch { notify("复制未完成，请选中文字复制"); } };
$("plain").onclick = () => { const enabled = document.body.classList.toggle("plain"); $("plain").setAttribute("aria-pressed", String(enabled)); $("plain").querySelector("span").textContent = enabled ? "阅读版" : "纯文本"; };
$("theme").onclick = () => { const enabled = document.body.classList.toggle("dark"); $("theme").setAttribute("aria-pressed", String(enabled)); $("theme").setAttribute("aria-label", enabled ? "切换浅色模式" : "切换深色模式"); };
$("smaller").onclick = () => { fontSize = Math.max(14, fontSize - 1); document.documentElement.style.setProperty("--body-size", fontSize + "px"); };
$("larger").onclick = () => { fontSize = Math.min(24, fontSize + 1); document.documentElement.style.setProperty("--body-size", fontSize + "px"); };
$("backtop").onclick = () => window.scrollTo({ top: 0, behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth" });
window.addEventListener("scroll", () => { const max = document.documentElement.scrollHeight - innerHeight; $("progress").style.width = `${max > 0 ? scrollY / max * 100 : 0}%`; }, { passive: true });
openPaste();
