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

// Keep the heading, its hard line breaks and its accessible name. Without motion
// or IntersectionObserver, the original HTML remains fully visible.
(() => {
  if (!window.IntersectionObserver || !matchMedia('(prefers-reduced-motion: no-preference)').matches) return;
  const headings = document.querySelectorAll('.cp-chapter h2');
  const observer = new IntersectionObserver(entries => {
    for (const {target, isIntersecting} of entries) {
      if (!isIntersecting) continue;
      target.classList.add('cp-seen');
      observer.unobserve(target);
    }
  }, {rootMargin:'0px 0px -4% 0px'});
  for (const h of headings) {
    const label = [...h.childNodes].map(n => n.nodeName === 'BR' ? ' ' : n.textContent).join('').replace(/\s+/g, ' ').trim();
    let i = 0;
    for (const node of [...h.childNodes]) {
      if (node.nodeType !== Node.TEXT_NODE) continue;
      const fragment = document.createDocumentFragment();
      for (const token of node.textContent.match(/\s+|\S+/g) || []) {
        if (!token.trim()) {fragment.append(token); continue;}
        const word = document.createElement('span');
        word.className = 'cp-head-word';
        word.setAttribute('aria-hidden','true');
        word.style.setProperty('--word', i++);
        word.textContent = token;
        fragment.append(word);
      }
      node.replaceWith(fragment);
    }
    h.setAttribute('aria-label',label);
    h.classList.add('cp-reveal-ready');
    observer.observe(h);
  }
})();

// Keep all three comments available without placing another screen of text
// between the phone preview and its gallery.
(() => {
  const notesButton = document.querySelector('.cp-team-toggle');
  notesButton.hidden = false;
  notesButton.addEventListener('click', () => {
    const wasOpen = notesButton.getAttribute('aria-expanded') === 'true';
    notesButton.setAttribute('aria-expanded', String(!wasOpen));
  });
})();
