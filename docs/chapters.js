/* Let the reader explore the recorded run without contacting a dashboard or model. */
(() => {
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const stacked = window.matchMedia('(min-width: 701px) and (max-width: 1023px)');
  const small = window.matchMedia('(max-width: 700px)');
  for (const group of document.querySelectorAll('[data-cp-tabs]')) {
    const tabs = Array.from(group.querySelectorAll('[role="tab"]'));
    const list = group.querySelector('[role="tablist"]');
    const panels = tabs.map(tab => document.getElementById(tab.getAttribute('aria-controls')));
    const mobileCaption = document.createElement('p');
    mobileCaption.className = 'cp-mobile-caption';
    list.after(mobileCaption);
    const playback = document.createElement('button');
    playback.type = 'button'; playback.className = 'cp-playback'; playback.hidden = true;
    group.append(playback);
    for (let i = 0; i < tabs.length; i++) {
      const caption = document.createElement('div'); caption.className = 'cp-tablet-caption';
      const title = document.createElement('h3'); title.textContent = tabs[i].querySelector('b').textContent;
      const text = document.createElement('p'); text.textContent = tabs[i].querySelector('span').textContent;
      caption.append(title, text); panels[i].append(caption);
    }
    let current = 0, manual = false, visible = false, hovered = false, timer;
    const autoAllowed = () => !small.matches && !stacked.matches && !reducedMotion.matches;
    function updateClock() {
      clearTimeout(timer);
      const running = visible && !document.hidden && !manual && !hovered && autoAllowed();
      group.dataset.cpPlaying = running ? 'yes' : 'no';
      playback.hidden = !autoAllowed();
      playback.textContent = manual ? '▷ Автопоказ' : 'Ⅱ Автопоказ';
      playback.setAttribute('aria-label', manual ? 'Включить автоматическую смену экранов' : 'Остановить автоматическую смену экранов');
      if (running) timer = setTimeout(() => select((current + 1) % tabs.length), 10500);
    }
    function select(index) {
      current = index;
      tabs.forEach((tab, i) => {
        const active = i === current;
        tab.setAttribute('aria-selected', String(active)); tab.tabIndex = active ? 0 : -1;
        panels[i].hidden = !stacked.matches && !active;
        if (stacked.matches) {
          panels[i].removeAttribute('aria-labelledby'); panels[i].setAttribute('role','group');
          panels[i].setAttribute('aria-label',tab.querySelector('b').textContent); panels[i].removeAttribute('tabindex');
        } else {
          panels[i].setAttribute('role','tabpanel'); panels[i].removeAttribute('aria-label');
          panels[i].setAttribute('aria-labelledby',tab.id); panels[i].tabIndex = 0;
        }
      });
      list.setAttribute('aria-orientation',small.matches ? 'horizontal' : 'vertical');
      mobileCaption.textContent = tabs[current].querySelector('span').textContent;
      if (small.matches) {
        const tab = tabs[current].getBoundingClientRect(), row = list.getBoundingClientRect();
        if (tab.right > row.right) list.scrollLeft += tab.right - row.right + 8;
        else if (tab.left < row.left) list.scrollLeft -= row.left - tab.left + 8;
      }
      updateClock();
    }
    tabs.forEach((tab,i) => {
      tab.addEventListener('click', () => {manual = true; select(i)});
      tab.addEventListener('keydown',event => {
        let next = i;
        if (event.key === 'ArrowRight' || event.key === 'ArrowDown') next = (i+1) % tabs.length;
        else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') next = (i+tabs.length-1) % tabs.length;
        else if (event.key === 'Home') next = 0;
        else if (event.key === 'End') next = tabs.length - 1;
        else return;
        event.preventDefault(); manual = true; select(next); tabs[next].focus();
      });
    });
    playback.addEventListener('click',()=>{manual=!manual; updateClock()});
    group.addEventListener('pointerenter',event=>{if(event.pointerType==='mouse'){hovered=true;updateClock()}});
    group.addEventListener('pointerleave',()=>{hovered=false;updateClock()});
    group.addEventListener('focusin',event=>{if(event.target!==playback){manual=true;updateClock()}});
    document.addEventListener('visibilitychange',updateClock);
    stacked.addEventListener('change',()=>select(current));small.addEventListener('change',()=>select(current));
    reducedMotion.addEventListener('change',updateClock);
    select(0);
    if ('IntersectionObserver' in window) new IntersectionObserver(entries=>{
      visible=entries[0].isIntersecting;updateClock();
    },{threshold:.28}).observe(group);
  }
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
  const questions = Array.from(document.querySelectorAll('.cp-questions details'));
  for (const details of questions) details.addEventListener('toggle',()=>{
    if(details.open) for(const other of questions) if(other!==details&&other.open) other.open=false;
  });
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
