(() => {
  const hero = document.querySelector('.pilot-hero');
  if (!hero) return;

  const frame = hero.querySelector('.pilot-hero-frame');
  const shell = hero.querySelector('.pilot-hero-shell');
  const question = hero.querySelector('.pilot-hero-question');
  const introLinks = hero.querySelectorAll('.pilot-hero-intro a');
  const desktop = matchMedia('(min-width:1024px) and (min-height:540px) and (prefers-reduced-motion:no-preference)');
  const cards = Array.from(hero.querySelectorAll('[data-hero-card]'), element => ({
    element,
    slot: hero.querySelector('[data-hero-slot="' + element.dataset.heroCard + '"]'),
    isPrompt: element.dataset.heroCard === 'prompt'
  }));

  const clamp = value => Math.max(0, Math.min(1, value));
  const lerp = (from, to, progress) => from + (to - from) * progress;
  function phase(progress, start, end) {
    const t = clamp((progress - start) / (end - start));
    return t * t * (3 - 2 * t);
  }

  const set = (name, value) => hero.style.setProperty('--hero-' + name, value);
  let viewportScale = 1;
  let travel = 1;
  let questionBox = [];
  let painted = 0;
  let target = 0;
  let lastTime = 0;
  let raf = 0;

  function draw(progress) {
    const dock = phase(progress, 0, .42);
    const heading = phase(progress, 0, .40);
    const typing = clamp((progress - .18) / .33);
    const send = phase(progress, .56, .93);
    const pageSwap = phase(progress, .52, .78);
    const receipt = phase(progress, .56, .96);
    const verify = phase(progress, .69, .94);

    introLinks.forEach(link => { link.inert = heading > .96; });
    set('heading', 1 - heading);
    set('heading-y', -heading * 192 * viewportScale + 'px');
    set('heading-scale', 1 - heading * .46);
    set('news', 1 - phase(progress, 0, .22));
    set('window', dock);
    set('shell-scale', .8 + .2 * dock);
    set('shell-y', (1 - dock) * 585 * viewportScale + 'px');
    set('wash-y', -phase(progress, 0, .43) * 112 * viewportScale + 'px');
    set('wash', 1 - .55 * phase(progress, .46, .98));
    set('home', 1 - pageSwap);
    set('cards', 1 - phase(progress, .59, .84));
    set('shadow', .2 * (1 - dock));
    set('pointers', 1 - phase(progress, .48, .68));
    set('type', (1 - typing) * 100 + '%');
    set('placeholder', 1 - phase(progress, .09, .25));
    set('send', send);
    set('tools', 1 - phase(progress, .48, .64));
    set('receipt', receipt);
    set('receipt-y', (1 - receipt) * 82 * viewportScale + 'px');
    set('verified', verify);
    set('verified-y', (1 - verify) * 16 + 'px');

    for (const card of cards) {
      const bounds = card.origin.map((value, i) => lerp(value, card.destination[i], dock));
      if (card.isPrompt && send > 0) {
        for (let i = 0; i < bounds.length; i++) bounds[i] = lerp(bounds[i], questionBox[i], send);
      }
      const [x, y, width, height] = bounds;
      card.element.style.transform = 'translate3d(' + x.toFixed(2) + 'px,' + y.toFixed(2) + 'px,0)';
      card.element.style.width = width.toFixed(2) + 'px';
      card.element.style.height = height.toFixed(2) + 'px';
    }
  }

  function scrollPosition() {
    return clamp(-hero.getBoundingClientRect().top / travel);
  }

  function measure() {
    if (!desktop.matches) return;
    const width = frame.clientWidth;
    const height = document.documentElement.clientHeight;
    const shellBounds = shell.getBoundingClientRect();
    const transformScale = shellBounds.width / shell.offsetWidth;
    const left = (width - shell.offsetWidth) / 2;
    viewportScale = shell.offsetWidth / 1200;
    travel = hero.offsetHeight - frame.offsetHeight;
    const offsetY = clamp((height - 800) / 400) * 200;
    const origins = {
      files: [-.006 * width, (130 + offsetY) * viewportScale, Math.min(.16 * width, 245), 235 * viewportScale],
      sessions: [left + 1100 * viewportScale, (320 + offsetY) * viewportScale, 294 * viewportScale, 235 * viewportScale],
      checks: [left - 20 * viewportScale, (600 + offsetY) * viewportScale, 294 * viewportScale, 200 * viewportScale],
      prompt: [left + 660 * viewportScale, (690 + offsetY) * viewportScale, 400 * viewportScale, 100 * viewportScale]
    };
    // Read each slot in the window's final coordinate system, even during a resize mid-flight.
    function atRest(element) {
      const box = element.getBoundingClientRect();
      return [
        left + (box.left - shellBounds.left) / transformScale,
        shell.offsetTop + (box.top - shellBounds.top) / transformScale,
        box.width / transformScale, box.height / transformScale
      ];
    }
    for (const card of cards) {
      card.origin = origins[card.element.dataset.heroCard];
      card.destination = atRest(card.slot);
    }
    questionBox = atRest(question);
    target = painted = scrollPosition();
    draw(painted);
  }

  function advance(now) {
    const elapsed = Math.min(80, Math.max(1, now - lastTime));
    lastTime = now;
    // Frame-rate independent follow-through, including trackpads and reverse scrolling.
    painted = lerp(painted, target, 1 - Math.exp(-elapsed / 104));
    if (Math.abs(target - painted) < .0002) painted = target;
    draw(painted);
    raf = painted === target ? 0 : requestAnimationFrame(advance);
  }

  function handleScroll() {
    if (!desktop.matches) return;
    target = scrollPosition();
    if (!raf && painted !== target) {
      lastTime = performance.now();
      raf = requestAnimationFrame(advance);
    }
  }

  function configure() {
    cancelAnimationFrame(raf);
    raf = 0;
    hero.classList.toggle('pilot-hero-animated', desktop.matches);
    introLinks.forEach(link => { link.inert = false; });
    measure();
  }
  desktop.addEventListener('change', configure);
  window.addEventListener('resize', measure, {passive:true});
  window.addEventListener('scroll', handleScroll, {passive:true});
  window.addEventListener('pageshow', measure);
  configure();
})();
