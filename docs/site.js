// The menus also work as native disclosure controls without JavaScript.
(() => {
  const mast = document.querySelector('.cp-mast');
  const menus = [...mast.querySelectorAll('details')];
  const close = (except) => menus.forEach(menu => { if (menu !== except) menu.open = false; });
  menus.forEach(menu => menu.addEventListener('toggle', () => { if (menu.open) close(menu); }));
  document.addEventListener('click', event => { if (event.target.closest('a') || !mast.contains(event.target)) close(); });
  document.addEventListener('focusin', event => { if (!mast.contains(event.target)) close(); });
  document.addEventListener('keydown', event => { if (event.key === 'Escape') { const open = menus.find(menu => menu.open); if (open) { close(); open.querySelector('summary').focus(); } } });
  const tint = () => mast.classList.toggle('is-scrolled', scrollY > 28);
  tint(); window.addEventListener('scroll', tint, {passive:true});
})();
