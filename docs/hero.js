(() => {
  const hero = document.querySelector('.pilot-hero');
  if (!hero) return;
  const frame = hero.querySelector('.pilot-hero-frame');
  const shell = hero.querySelector('.pilot-hero-shell');
  const introLinks = hero.querySelectorAll('.pilot-hero-intro a');
  const desktop = matchMedia('(min-width:761px) and (min-height:540px) and (prefers-reduced-motion:no-preference)');
  const cards = [...hero.querySelectorAll('[data-hero-card]')].map(element => ({
    element,
    slot: hero.querySelector('[data-hero-slot="' + element.dataset.heroCard + '"]')
  }));
  let geometry = [];
  let scrollFrame = 0;
  let lastProgress = -1;

  const clamp = (value, minimum = 0, maximum = 1) => Math.max(minimum, Math.min(maximum, value));
  const lerp = (from, to, progress) => from + (to - from) * progress;
  function interval(progress, start, end) {
    const value = clamp((progress - start) / (end - start));
    return value * value * (3 - 2 * value);
  }
  function set(name, value) {
    hero.style.setProperty('--hero-' + name, value);
  }
  function measure() {
    if (!desktop.matches) return;
    const bounds = frame.getBoundingClientRect();
    const shellBounds = shell.getBoundingClientRect();
    const width = bounds.width;
    const height = bounds.height;
    const shellOffset = shellBounds.top - bounds.top - shell.offsetTop;
    const origins = {
      files: [-.006 * width, .17 * height, Math.min(.16 * width,245), Math.min(.305 * height,235)],
      sessions: [.865 * width, .415 * height, Math.min(.225 * width,325), Math.min(.305 * height,235)],
      checks: [.048 * width, .78 * height, Math.min(.215 * width,310), Math.min(.245 * height,193)],
      prompt: [.544 * width, .894 * height, Math.min(.294 * width,435), Math.min(.15 * height,113)]
    };
    geometry = cards.map(({ element, slot }) => {
      const target = slot.getBoundingClientRect();
      return {
        element,
        origin:origins[element.dataset.heroCard],
        target:[target.left - bounds.left, target.top - bounds.top - shellOffset, target.width, target.height]
      };
    });
    lastProgress = -1;
    render();
  }
  function render() {
    scrollFrame = 0;
    if (!desktop.matches || !geometry.length) return;
    const progress = clamp(-hero.getBoundingClientRect().top / Math.max(1, hero.offsetHeight - frame.offsetHeight));
    if (progress === lastProgress) return;
    lastProgress = progress;

    const headline = interval(progress, .015, .19);
    const dock = interval(progress, .025, .37);
    const windowIn = interval(progress, .12, .37);
    const type = interval(progress, .36, .5);
    const pageSwap = interval(progress, .54, .67);
    const receipt = interval(progress, .59, .75);
    const verify = interval(progress, .73, .88);
    introLinks.forEach(link => { link.inert = headline > .96; });
    set('heading', 1 - headline);
    set('heading-y', -headline * 48 + 'px');
    set('heading-scale', 1 - headline * .065);
    set('window', windowIn);
    set('shell-y', (1 - windowIn) * 55 + 'px');
    set('home', 1 - pageSwap);
    set('cards', 1 - pageSwap);
    set('shadow', .18 - dock * .13);
    set('pointers', 1 - interval(progress, .38, .52));
    set('type', (1 - type) * 100 + '%');
    set('placeholder', 1 - interval(progress, .32, .365));
    set('receipt', receipt);
    set('receipt-y', (1 - receipt) * 18 + 'px');
    set('verified', verify);
    set('verified-y', (1 - verify) * 12 + 'px');

    geometry.forEach(({ element, origin, target }) => {
      const x = lerp(origin[0], target[0], dock);
      const y = lerp(origin[1], target[1], dock);
      element.style.transform = 'translate3d(' + x.toFixed(2) + 'px,' + y.toFixed(2) + 'px,0)';
      element.style.width = lerp(origin[2], target[2], dock).toFixed(2) + 'px';
      element.style.height = lerp(origin[3], target[3], dock).toFixed(2) + 'px';
    });
  }
  function handleScroll() {
    if (desktop.matches && !scrollFrame) scrollFrame = requestAnimationFrame(render);
  }
  function configure() {
    hero.classList.toggle('pilot-hero-animated', desktop.matches);
    introLinks.forEach(link => { link.inert = false; });
    if (desktop.matches) measure();
  }
  desktop.addEventListener('change', configure);
  window.addEventListener('resize', measure, { passive:true });
  window.addEventListener('scroll', handleScroll, { passive:true });
  window.addEventListener('pageshow', measure);
  configure();
})();
