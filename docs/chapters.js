/* Let the reader explore the recorded run without contacting a dashboard or model. */
(() => {
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const compact = window.matchMedia('(max-width: 1023px)');
  const wide = window.matchMedia('(min-width: 1280px)');
  const readingTimes = [9000, 9500, 8000, 10000, 8500, 8000];

  for (const group of document.querySelectorAll('[data-cp-tabs]')) {
    const tabs = Array.from(group.querySelectorAll('[role="tab"]'));
    const panels = tabs.map(tab => document.getElementById(tab.getAttribute('aria-controls')));
    const home = panels[0].parentElement;
    const list = group.querySelector('[role="tablist"]');
    const isRun = Boolean(group.closest('#case'));
    const caption = document.createElement('p');
    caption.className = 'cp-mobile-caption';
    list.after(caption);

    // At narrow widths the first few screens are read in order. The remaining
    // screens form a swipe gallery. Both layouts use the same panel elements.
    const reader = document.createElement('div');
    reader.className = 'cp-reader';
    const rail = document.createElement('div');
    rail.className = 'cp-reader-rail';
    rail.tabIndex = 0;
    rail.setAttribute('role', 'region');
    rail.setAttribute('aria-label', isRun ? 'Ещё три этапа запуска' : 'Ещё три вида памяти');
    const controls = document.createElement('div');
    controls.className = 'cp-reader-controls';
    const arrows = [-1, 1].map(direction => {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = direction < 0 ? '←' : '→';
      button.setAttribute('aria-label', direction < 0 ? 'Предыдущий экран' : 'Следующий экран');
      button.addEventListener('click', () => {
        const stops = [...rail.children].map(item => item.offsetLeft - rail.firstElementChild.offsetLeft);
        const next = direction > 0 ? stops.find(stop => stop > rail.scrollLeft + 3)
          : stops.reverse().find(stop => stop < rail.scrollLeft - 3);
        rail.scrollTo({left: next ?? (direction > 0 ? rail.scrollWidth : 0),
          behavior: reducedMotion.matches ? 'instant' : 'smooth'});
      });
      controls.append(button);
      return button;
    });
    reader.append(rail, controls);
    group.append(reader);
    function updateArrows() {
      arrows[0].disabled = rail.scrollLeft <= 2;
      arrows[1].disabled = rail.scrollWidth - rail.clientWidth - rail.scrollLeft <= 2;
    }
    rail.addEventListener('scroll', updateArrows, {passive: true});
    new ResizeObserver(updateArrows).observe(rail);

    tabs.forEach((tab, index) => {
      const label = document.createElement('div');
      label.className = 'cp-tablet-caption';
      const title = document.createElement('h3');
      title.textContent = tab.querySelector('b').textContent;
      const text = document.createElement('p');
      text.textContent = tab.querySelector('span').textContent;
      label.append(title, text);
      panels[index].append(label);
    });

    const playback = document.createElement('button');
    playback.type = 'button';
    playback.className = 'cp-playback';
    if (isRun) group.append(playback);
    let current = 0, elapsed = 0, frame = 0, lastTick = 0;
    let paused = false, hovered = false, inView = false, finished = false;
    function tick(now) {
      if (lastTick) elapsed += now - lastTick;
      lastTick = now;
      const progress = Math.min(1, elapsed / readingTimes[current]);
      tabs[current].style.setProperty('--cp-progress', progress);
      if (progress < 1) frame = requestAnimationFrame(tick);
      else if (current < tabs.length - 1) select(current + 1);
      else {
        finished = true;
        refreshPlayback();
      }
    }
    function refreshPlayback() {
      cancelAnimationFrame(frame);
      lastTick = 0;
      const available = isRun && !compact.matches && !reducedMotion.matches;
      playback.hidden = !available;
      playback.textContent = finished ? 'Повторить показ' : paused ? 'Продолжить показ' : 'Пауза';
      playback.setAttribute('aria-label', finished ? 'Повторить показ этапов' : paused
        ? 'Продолжить автоматическую смену экранов' : 'Остановить автоматическую смену экранов');
      if (available && inView && !paused && !hovered && !finished && !document.hidden)
        frame = requestAnimationFrame(tick);
    }
    function select(index) {
      current = index;
      elapsed = 0;
      finished = false;
      tabs.forEach((tab, i) => {
        const active = i === index;
        tab.setAttribute('aria-selected', String(active));
        tab.tabIndex = active ? 0 : -1;
        tab.style.setProperty('--cp-progress', active && (!isRun || paused) ? '1' : '0');
        panels[i].hidden = !compact.matches && !active;
      });
      caption.textContent = tabs[index].querySelector('span').textContent;
      refreshPlayback();
    }
    function layout() {
      group.classList.toggle('cp-reading', compact.matches);
      reader.hidden = !compact.matches;
      panels.forEach((panel, index) => {
        if (compact.matches) {
          if (index < (isRun ? 3 : 2)) reader.insertBefore(panel, rail);
          else rail.append(panel);
          panel.setAttribute('role', 'group');
          panel.removeAttribute('aria-labelledby');
          panel.setAttribute('aria-label', tabs[index].querySelector('b').textContent);
          panel.removeAttribute('tabindex');
        } else {
          home.append(panel);
          panel.setAttribute('role', 'tabpanel');
          panel.setAttribute('aria-labelledby', tabs[index].id);
          panel.removeAttribute('aria-label');
          panel.tabIndex = 0;
        }
      });
      list.setAttribute('aria-orientation', wide.matches ? 'vertical' : 'horizontal');
      select(current);
      updateArrows();
    }

    tabs.forEach((tab, index) => {
      tab.addEventListener('click', () => { paused = true; select(index); });
      tab.addEventListener('keydown', event => {
        const keys = {
          ArrowRight: (index + 1) % tabs.length, ArrowDown: (index + 1) % tabs.length,
          ArrowLeft: (index + tabs.length - 1) % tabs.length, ArrowUp: (index + tabs.length - 1) % tabs.length,
          Home: 0, End: tabs.length - 1
        };
        if (!(event.key in keys)) return;
        event.preventDefault();
        paused = true;
        select(keys[event.key]);
        tabs[current].focus();
      });
    });
    playback.addEventListener('click', () => {
      if (finished) { paused = false; select(0); }
      else { paused = !paused; refreshPlayback(); }
    });
    group.addEventListener('pointerenter', event => {
      if (event.pointerType === 'mouse') { hovered = true; refreshPlayback(); }
    });
    group.addEventListener('pointerleave', () => { hovered = false; refreshPlayback(); });
    group.addEventListener('focusin', event => {
      if (event.target !== playback && isRun) { paused = true; refreshPlayback(); }
    });
    compact.addEventListener('change', layout);
    wide.addEventListener('change', layout);
    reducedMotion.addEventListener('change', refreshPlayback);
    document.addEventListener('visibilitychange', refreshPlayback);
    layout();
    const observer = new IntersectionObserver(([entry]) => {
      inView = entry.isIntersecting;
      refreshPlayback();
    }, {rootMargin: '0px 0px -12% 0px'});
    observer.observe(group);
  }
  // Recover a visible frame immediately on deep links or reduced-motion devices.
  // Only a graphic that actually enters the viewport gets an entrance motion.
  const stages = new IntersectionObserver(entries => {
    for (const entry of entries) {
      const reply = entry.target.classList.contains('cp-q');
      const motion = reply ? 'cp-reply-enter' : 'cp-stage-enter';
      entry.target.classList.toggle(motion, entry.isIntersecting);
    }
  }, {rootMargin: '0px 0px -9% 0px', threshold: .12});
  document.querySelectorAll('.cp-story-art, .cp-memory .cp-map, .cp-darkdoc, .cp-q').forEach(stage => stages.observe(stage));

  const cards = Array.from(document.querySelectorAll('.cp-values .cp-triptych article'));
  for (const card of cards) {
    const activate = () => {for (const item of cards) item.classList.toggle('cp-card-active',item===card)};
    card.addEventListener('pointerenter', activate); card.addEventListener('focus',activate);
    card.addEventListener('click',activate);
  }
  const story = document.querySelector('#story');
  if (story) {
    const moments = Array.from(story.querySelectorAll('[data-cp-moment]'));
    const chapters = Array.from(story.querySelectorAll('[data-cp-story]'));
    moments.forEach((moment,i)=>moment.addEventListener('click',()=>{
      moments.forEach((b,j)=>b.setAttribute('aria-pressed',String(i===j)));
      chapters.forEach((chapter,j)=>{chapter.hidden=i!==j});
      story.dataset.storyColor=String(i);
    }));
  }
  const copy=document.getElementById('copy'), command=document.getElementById('commands'), status=document.getElementById('cp-copy-status');
  if(copy&&command&&status) copy.addEventListener('click',async()=>{
    try {
      await navigator.clipboard.writeText(command.textContent.trim());
      copy.textContent='Скопировано'; status.textContent='Команда установки в буфере обмена.';
    } catch {
      const details=command.closest('details');if(details) details.open=true;
      const selection=window.getSelection(), range=document.createRange();
      range.selectNodeContents(command);
      if(selection){selection.removeAllRanges();selection.addRange(range)}
      status.textContent='Команда выделена. Скопируйте её в терминал.';
    }
  });
  if('IntersectionObserver' in window){
    const reveal=new IntersectionObserver(items=>{for(const item of items)if(item.isIntersecting){item.target.classList.add('cp-in');reveal.unobserve(item.target)}},{threshold:.09});
    document.querySelectorAll('.cp-triptych,.cp-handoff-scene').forEach(el=>reveal.observe(el));
  }
})();
