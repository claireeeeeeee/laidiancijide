(() => {
'use strict';

const DISMISSED = 'ldc_install_tip_dismissed';
const agent = navigator.userAgent;
const ios = /iPhone|iPad|iPod/i.test(agent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const android = /Android/i.test(agent);
const wechat = /MicroMessenger/i.test(agent);
const safari = /Safari\//.test(agent) && !/CriOS|FxiOS|EdgiOS|OPiOS|DuckDuckGo/i.test(agent);
const chrome = /Chrome\//.test(agent) && !/SamsungBrowser|EdgA|OPR|UCBrowser|; wv\b/i.test(agent);
let dismissed = false;
try { dismissed = localStorage.getItem(DISMISSED) === '1'; } catch {}

function isOnHomeScreen() {
  return navigator.standalone === true || matchMedia('(display-mode: standalone)').matches;
}
function slot() {
  if ((!ios && !android) || isOnHomeScreen()) return '';
  if (dismissed) return '<div class="install-guide-short"><button type="button" class="link" data-install="open">添加到手机桌面</button></div>';
  return `<aside class="install-guide-tip" aria-label="添加到手机桌面">
    <div><strong>添加到手机桌面</strong><small>下次点图标就能打开</small></div>
    <div class="install-guide-actions">
      <button type="button" class="chip" data-install="open">查看步骤</button>
      <button type="button" class="link" data-install="later">稍后</button>
    </div>
  </aside>`;
}
function dismiss() {
  dismissed = true;
  try { localStorage.setItem(DISMISSED, '1'); } catch {}
  document.querySelectorAll('.install-guide-tip').forEach(tip => { tip.outerHTML = slot(); });
}
function shortcutURL() {
  const url = new URL(location.href);
  const code = url.searchParams.get('r');
  const mock = url.searchParams.has('mock');
  url.hash = '';
  url.search = '';
  if (/^[0-9]{6}$/.test(code || '')) url.searchParams.set('r', code);
  if (mock) url.searchParams.set('mock', '1');
  return url;
}
function instructions() {
  const steps = ios ? [
    '在 Safari 点「分享」。如果没看到，先打开页面菜单，再点「分享」。',
    '往下滑，点「添加到主屏幕」。找不到时，可以到「编辑操作」里把它加出来。',
    '点「添加」，就能在手机桌面看到图标。'
  ] : [
    '在安卓 Chrome 点右上角的三个点 ⋮。',
    '点「添加到主屏幕」或「安装和创建快捷方式」，再选择「创建快捷方式」。',
    '点「添加」，就能在手机桌面看到图标。'
  ];
  return `<ol>${steps.map(text => `<li>${text}</li>`).join('')}</ol>`;
}
function openGuide() {
  const link = shortcutURL();
  const room = link.searchParams.get('r');
  const browser = ios ? 'Safari' : 'Chrome';
  const needsBrowser = wechat || (ios && !safari) || (android && !chrome);
  const dialog = document.createElement('dialog');
  dialog.className = 'install-guide-dialog';
  dialog.setAttribute('aria-labelledby', 'install-guide-title');
  dialog.innerHTML = `<h2 id="install-guide-title">添加到手机桌面</h2>
    <p class="install-guide-destination">${room ? '保存后会直接打开房间 ' + room : '保存后会打开游戏首页。'}</p>
    ${needsBrowser ? `<section class="install-guide-browser">
      <p>${wechat ? '你现在在微信里。' : ''}复制链接，再到 ${browser} 打开。</p>
      <button type="button" class="btn b3" data-install="copy">复制链接</button>
      <div class="install-guide-copy-status" role="status"></div>
      <input type="url" aria-label="要保存的网址" readonly hidden>
    </section><details><summary>在 ${browser} 打开后怎么添加</summary>${instructions()}</details>`
      : instructions()}
    <form method="dialog"><button class="btn b1">知道了</button></form>`;
  const input = dialog.querySelector('input');
  if (input) {
    input.value = link.href;
    dialog.querySelector('[data-install="copy"]').addEventListener('click', async () => {
      const status = dialog.querySelector('[role="status"]');
      try {
        await navigator.clipboard.writeText(link.href);
        status.textContent = '已复制。';
      } catch {
        input.hidden = false;
        input.focus();
        input.select();
        status.textContent = '长按链接复制。';
      }
    });
  }
  dialog.querySelector('form').addEventListener('submit', dismiss, {once:true});
  dialog.addEventListener('cancel', dismiss, {once:true});
  dialog.addEventListener('close', () => {
    dialog.remove();
    document.querySelector('button[data-install="open"]')?.focus();
  }, {once:true});
  document.body.append(dialog);
  dialog.showModal();
}
document.addEventListener('click', event => {
  const button = event.target.closest('button[data-install]');
  if (button?.dataset.install === 'open') openGuide();
  if (button?.dataset.install === 'later') dismiss();
});

window.LdcInstallGuide = {slot};
})();
