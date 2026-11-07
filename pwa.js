(() => {
  'use strict';

  const installButtons = [
    document.getElementById('install-app-btn'),
    document.getElementById('mobile-install-app-btn')
  ].filter(Boolean);

  let deferredInstallPrompt = null;

  const isStandalone = () =>
    window.matchMedia?.('(display-mode: standalone)').matches ||
    window.navigator.standalone === true;

  const isIOS = () => /iphone|ipad|ipod/i.test(navigator.userAgent || '');

  function setInstallVisible(visible) {
    installButtons.forEach(button => button.classList.toggle('hidden', !visible));
  }

  function notify(message) {
    if (typeof window.showToast === 'function') {
      window.showToast(message);
      return;
    }
    window.alert(message);
  }

  function closeMobileMenu() {
    const menu = document.getElementById('mobile-menu-dialog');
    if (!menu) return;
    menu.classList.remove('is-open');
    menu.setAttribute('aria-hidden', 'true');
    document.body.classList.remove('mobile-menu-open');
  }

  async function installApp() {
    closeMobileMenu();

    if (isStandalone()) {
      setInstallVisible(false);
      notify('CB Butchers už je nainstalovaná aplikace.');
      return;
    }

    if (deferredInstallPrompt) {
      const prompt = deferredInstallPrompt;
      deferredInstallPrompt = null;
      await prompt.prompt();
      const choice = await prompt.userChoice.catch(() => null);
      if (choice?.outcome === 'accepted') {
        setInstallVisible(false);
      } else {
        setInstallVisible(true);
      }
      return;
    }

    if (isIOS()) {
      notify('Na iPhonu otevři web v Safari → Sdílet → Přidat na plochu.');
      return;
    }

    notify('Instalaci najdeš v menu prohlížeče jako „Instalovat aplikaci“ nebo „Přidat na plochu“.');
  }

  installButtons.forEach(button => button.addEventListener('click', installApp));

  window.addEventListener('beforeinstallprompt', event => {
    event.preventDefault();
    deferredInstallPrompt = event;
    if (!isStandalone()) setInstallVisible(true);
  });

  window.addEventListener('appinstalled', () => {
    deferredInstallPrompt = null;
    setInstallVisible(false);
    notify('CB Butchers byla nainstalována.');
  });

  // iOS nemá beforeinstallprompt, ale instalaci přes plochu podporuje.
  if (!isStandalone() && isIOS()) setInstallVisible(true);
  if (isStandalone()) setInstallVisible(false);

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('./sw.js', { scope: './' }).catch(error => {
        console.warn('PWA service worker se nepodařilo zaregistrovat:', error);
      });
    });
  }
})();
