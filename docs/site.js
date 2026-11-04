// The same four fragments form the cover and then settle into the project view.
const film = document.querySelector('.film');
const frame = document.querySelector('.frame');
const header = document.querySelector('header');
const headline = document.querySelector('.headline');
const fragments = [...frame.querySelectorAll('[data-origin]')];
const reduced = matchMedia('(prefers-reduced-motion: reduce)');
let offsets = [], pending = false;

function measure() {
  const w = frame.clientWidth, h = frame.clientHeight;
  const compact = w <= 650;
  const storyBottom = headline.offsetTop + headline.offsetHeight;
  const mobileCards = Math.max(storyBottom + 28, h * .59);
  const origins = {
    files: [compact ? -14 : -.014*w, compact ? mobileCards : .17*h],
    tests: [compact ? .68*w : .865*w, compact ? mobileCards+24 : .415*h],
    run: [.045*w, .88*h],
    composer: [compact ? .25*w : .545*w, compact ? mobileCards+145 : .895*h]
  };
  offsets = fragments.map(el => {
    const [x,y] = origins[el.dataset.origin];
    return [x-el.offsetLeft,y-el.offsetTop];
  });
  paint();
}
function paint() {
  pending = false;
  const distance = Math.max(1, film.offsetHeight-frame.offsetHeight);
  const raw = Math.min(1, Math.max(0, -film.getBoundingClientRect().top / distance));
  const p = reduced.matches ? Number(raw > .5) : raw*raw*(3-2*raw);
  frame.style.setProperty('--title-scale',1-.45*p);
  frame.style.setProperty('--title-alpha',Math.max(0,1-2*p));
  frame.style.setProperty('--window-alpha',Math.min(1,1.75*p));
  frame.style.setProperty('--window-y',36*(1-p)+'px');
  fragments.forEach((el,i) => {
    const [x,y] = offsets[i];
    el.style.transform = 'translate('+x*(1-p)+'px,'+y*(1-p)+'px)';
  });
  headline.inert = p > .58;
  header.classList.toggle('scrolled', window.scrollY > 30);
}
function queuePaint() {
  if (!pending) {pending=true; requestAnimationFrame(paint);}
}
addEventListener('scroll',queuePaint,{passive:true});
new ResizeObserver(measure).observe(frame);
reduced.addEventListener('change',measure);
measure();

const tabs=[...document.querySelectorAll('[data-tab]')];
const panels=[...document.querySelectorAll('.case-panel')];
tabs.forEach((button,i)=>button.addEventListener('click',()=>{
  tabs.forEach((tab,j)=>{tab.setAttribute('aria-pressed',String(i===j));panels[j].hidden=i!==j;});
}));
const observer=new IntersectionObserver(entries=>{
  for(const entry of entries) if(entry.isIntersecting){entry.target.classList.add('in');observer.unobserve(entry.target);}
},{threshold:.2});
observer.observe(document.querySelector('.grid'));
document.querySelector('#copy').addEventListener('click',async event=>{
  const button=event.currentTarget, commands=document.querySelector('#commands');
  try { await navigator.clipboard.writeText(commands.textContent); button.textContent='Скопировано'; }
  catch { const range=document.createRange();range.selectNodeContents(commands);const selection=getSelection();selection.removeAllRanges();selection.addRange(range);button.textContent='Текст выделен'; }
});
document.querySelectorAll('.stage,.spread').forEach(el=>observer.observe(el));
