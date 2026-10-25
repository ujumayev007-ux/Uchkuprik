// If the application has not started 20 s after loading (a browser too old for it, e.g.
// an outdated Android System WebView on a TV), say so on the loading screen instead of
// leaving it blank, with the browser version for support. Plain ES5 on purpose.
(function () {
  setTimeout(function () {
    var root = document.getElementById('root');
    var splash = document.getElementById('boot-splash');
    if (!splash || (root && root.children.length > 0)) return;
    var box = document.createElement('p');
    box.style.maxWidth = '40rem';
    box.style.margin = '1.5rem auto 0';
    box.style.lineHeight = '1.5';
    box.appendChild(
      document.createTextNode(
        'Dastur ishga tushmadi: bu qurilmaning brauzeri (Android System WebView) eskirgan. ' +
          'Play Market’da «Android System WebView» ni yangilang yoki qurilmani qayta yoqing.'
      )
    );
    var version = document.createElement('small');
    version.style.display = 'block';
    version.style.marginTop = '0.75rem';
    version.style.opacity = '0.7';
    version.appendChild(document.createTextNode(navigator.userAgent));
    box.appendChild(version);
    (splash.firstElementChild || splash).appendChild(box);
  }, 20000);
})();
