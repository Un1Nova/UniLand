'use strict';
(() => {
  const app=window.UniLand,$=id=>document.getElementById(id),esc=app.esc;
  const plain=value=>String(value??'').replace(/§./g,'');
  let loading=null,ready=false,error=false,quests=[],lines=[],pages=[],questById=new Map(),pageById=new Map(),itemVariants=new Map();
  let mapState={chapter:null,x:0,y:0,scale:1,width:1,height:1},drag=null,preventClick=false;
  let savedCompleted=[];try{const stored=JSON.parse(localStorage.getItem('uniland.completedQuests')||'[]');if(Array.isArray(stored))savedCompleted=stored;}catch{}
  const completed=new Set(savedCompleted.map(String));
  const props=q=>q?.properties?.betterquesting||{};
  const pageKey=p=>p.metadata?.id||p.resource;
  function indexItems(){itemVariants=new Map();for(const item of app.items.values()){if(!itemVariants.has(item.registryId))itemVariants.set(item.registryId,[]);itemVariants.get(item.registryId).push(item);}}
  window.addEventListener('uniland-ready',indexItems);
  async function ensure(){
    if(ready)return;if(loading)return loading;
    loading=(async()=>{try{
      const responses=await Promise.all(['data/quests.json','data/quest-lines.json','data/knowledge.json'].map(async file=>{const r=await fetch(file);if(!r.ok)throw new Error(file);return r.json();}));
      [quests,lines]=responses;pages=responses[2].pages;
      questById=new Map(quests.map(q=>[String(q.questID),q]));lines.sort((a,b)=>a.order-b.order);
      pageById=new Map(pages.map(p=>[pageKey(p),p]));indexItems();ready=true;error=false;configureFilter();
    }catch{error=true;}finally{loading=null;if(app.state.view!=='catalog')app.renderCatalog();}})();return loading;
  }
  function configureFilter(){
    const filter=$('mod-filter');
    if(app.state.view==='quests'){
      filter.innerHTML=lines.map(line=>`<option value="${line.lineID}">${esc(plain(props(line).name))}</option>`).join('');
      if(!lines.some(x=>String(x.lineID)===app.state.mod))app.state.mod=String(lines[0]?.lineID??'');
      filter.value=app.state.mod;$('search-input').placeholder='Найти квест или предмет задания';filter.setAttribute('aria-label','Глава квестов');
    }else if(app.state.view==='guides'){
      filter.innerHTML='<option value="">Все материалы</option><option value="guide">Гайды</option><option value="wiki">Вики</option>';
      filter.value=app.state.mod;$('search-input').placeholder='Найти гайд, предмет или механику';filter.setAttribute('aria-label','Тип материала');
    }
  }
  function itemFrom(spec){
    if(!spec)return null;if(typeof spec==='string')return app.items.get(spec)||itemVariants.get(spec)?.[0];
    if(spec.itemId)return app.items.get(spec.itemId);
    const variants=itemVariants.get(spec.item||spec.id)||[],damage=spec.meta??spec.Damage;
    let candidates=damage===undefined?variants:variants.filter(x=>x.damage===Number(damage));
    if(spec.nbt){const type=String(spec.nbt).match(/type\s*:\s*["']([^"']+)/)?.[1];if(type)candidates=candidates.filter(x=>x.nbt?.value?.type?.value===type);}
    return candidates.find(x=>!x.nbt)||candidates[0]||null;
  }
  function itemButton(spec, count, className='knowledge-item'){
    const item=itemFrom(spec);if(!item)return `<span class="knowledge-unresolved">${esc(spec?.id||spec?.item||spec||'Предмет')}</span>`;
    const amount=count??spec?.Count??1;
    return `<button type="button" class="${className}" data-select="${esc(item.id)}">${app.image(item)}<span>${esc(item.name)}</span>${Number(amount)!==1?`<span class="knowledge-amount">× ${esc(app.num(amount))}</span>`:''}</button>`;
  }
  function header(title,subtitle,icon='book'){
    return `<div class="inspector-nav"><span class="detail-eyebrow">${esc(subtitle)}</span><button class="icon-button" type="button" data-action="close-item" aria-label="Закрыть">${app.icons.close}</button></div><div class="knowledge-detail-heading"><span>${app.icons[icon]}</span><h2>${esc(plain(title))}</h2></div>`;
  }
  function renderView(){
    const host=$('knowledge-view');
    if(!ready){host.innerHTML=`<div class="empty-state"><h2>${error?'Не удалось загрузить материалы':'Загрузка…'}</h2>${error?'<button type="button" class="text-button" data-knowledge-retry>Повторить</button>':''}</div>`;if(!error)ensure();return;}
    if(app.state.view==='quests')renderQuests(host);else renderGuides(host);
  }
  function matching(text){return app.norm(app.state.query).split(/\s+/).filter(Boolean).every(word=>app.norm(text).includes(word));}
  function renderQuests(host){
    const line=lines.find(x=>String(x.lineID)===app.state.mod)||lines[0];if(!line)return;
    const nodes=line.quests.filter(n=>questById.has(String(n.id))),ids=new Set(nodes.map(n=>String(n.id)));
    const found=quests.filter(q=>matching([props(q).name,props(q).desc,...(q.tasks||[]).flatMap(t=>(t.requiredItems||[]).map(s=>itemFrom(s)?.name||s.id))].join(' ')));
    $('result-count').textContent=app.state.query?`${found.length} найдено`:`${nodes.length} квестов`;$('page-title').textContent='Квесты';
    const minX=Math.min(...nodes.map(n=>n.x))-24,minY=Math.min(...nodes.map(n=>n.y))-24;
    const width=(Math.max(...nodes.map(n=>n.x+n.sizeX))-minX+24)*3,height=(Math.max(...nodes.map(n=>n.y+n.sizeY))-minY+24)*3;
    const position=new Map(nodes.map(n=>[String(n.id),{x:(n.x-minX)*3,y:(n.y-minY)*3,w:n.sizeX*3,h:n.sizeY*3}]));
    const foundIds=new Set(found.map(q=>String(q.questID)));
    const links=nodes.flatMap(node=>(questById.get(String(node.id)).preRequisites||[]).filter(id=>ids.has(String(id))).map(id=>{
      const a=position.get(String(id)),b=position.get(String(node.id));return `<path d="M${a.x+a.w/2},${a.y+a.h/2} L${b.x+b.w/2},${b.y+b.h/2}"/>`;
    })).join('');
    host.innerHTML=`<div class="knowledge-topline"><div><h2>${esc(plain(props(line).name))}</h2><p>Связи и расположение из квестовой книги</p></div><div class="map-controls"><button class="icon-button" type="button" data-map-zoom="-1" aria-label="Уменьшить">−</button><button class="map-fit" type="button" data-map-fit>Вся глава</button><button class="icon-button" type="button" data-map-zoom="1" aria-label="Увеличить">+</button></div></div>${app.state.query?`<div class="quest-search-results">${found.slice(0,100).map(q=>`<button type="button" data-quest="${q.questID}">${app.image(itemFrom(props(q).icon))}<span>${esc(plain(props(q).name))}</span></button>`).join('')||'<p>Ничего не найдено</p>'}${found.length>100?'<p>Уточни поиск, чтобы увидеть остальные квесты.</p>':''}</div>`:''}<div class="quest-map" id="quest-map" tabindex="0" role="region" aria-label="Карта квестов. Перетаскивай для перемещения, используй плюс и минус для масштаба."><div class="quest-world" id="quest-world" style="width:${width}px;height:${height}px"><svg class="quest-links" viewBox="0 0 ${width} ${height}" aria-hidden="true">${links}</svg>${nodes.map(node=>{const q=questById.get(String(node.id)),p=position.get(String(node.id));return `<button type="button" class="quest-node${completed.has(String(node.id))?' completed':''}${app.state.query&&!foundIds.has(String(node.id))?' dimmed':''}" data-quest="${node.id}" style="left:${p.x}px;top:${p.y}px;width:${p.w}px;height:${p.h}px" title="${esc(plain(props(q).name))}" aria-label="${esc(plain(props(q).name))}">${app.image(itemFrom(props(q).icon))}<span class="quest-node-name">${esc(plain(props(q).name))}</span></button>`;}).join('')}</div></div><div class="map-caption"><span>Потяни карту, чтобы переместиться</span><span>Отметки выполнения сохраняются на этом устройстве</span></div>`;
    const changed=mapState.chapter!==line.lineID;mapState.chapter=line.lineID;mapState.width=width;mapState.height=height;
    if(changed)requestAnimationFrame(fitMap);else transformMap();highlightSelection();
  }
  function transformMap(){const world=$('quest-world');if(world)world.style.transform=`translate(${mapState.x}px,${mapState.y}px) scale(${mapState.scale})`;}
  function fitMap(){const map=$('quest-map');if(!map)return;mapState.scale=Math.min((map.clientWidth-28)/mapState.width,(map.clientHeight-28)/mapState.height,1.2);mapState.x=(map.clientWidth-mapState.width*mapState.scale)/2;mapState.y=(map.clientHeight-mapState.height*mapState.scale)/2;transformMap();}
  function zoom(factor,x,y){const map=$('quest-map');if(!map)return;x??=map.clientWidth/2;y??=map.clientHeight/2;const scale=Math.min(5,Math.max(.08,mapState.scale*factor));mapState.x=x-(x-mapState.x)*scale/mapState.scale;mapState.y=y-(y-mapState.y)*scale/mapState.scale;mapState.scale=scale;transformMap();}
  function highlightSelection(){document.querySelectorAll('.quest-node').forEach(node=>node.classList.toggle('selected',app.state.entity?.kind==='quest'&&node.dataset.quest===app.state.entity.id));}
  function renderGuides(host){
    const found=pages.filter(p=>(!app.state.mod||p.kind===app.state.mod)&&matching(`${p.metadata?.title||''} ${p.markdown} ${p.metadata?.id||''}`));
    $('result-count').textContent=`${found.length} материалов`;$('page-title').textContent='Гайды';
    const size=app.capacity(true);app.pagination(found.length,size);
    host.innerHTML=`<div class="knowledge-topline"><div><h2>${app.state.mod==='wiki'?'Вики':app.state.mod==='guide'?'Гайды':'Библиотека'}</h2><p>Знания о мире, предметах и механизмах</p></div></div><div class="guide-grid">${found.slice(app.state.page*size,(app.state.page+1)*size).map(p=>`<button class="guide-card" type="button" data-guide="${esc(pageKey(p))}">${app.image(itemFrom(p.metadata?.icon))}<span class="guide-card-copy"><span class="detail-eyebrow">${p.kind==='guide'?'Гайд':'Вики'}</span><strong>${esc(plain(p.metadata?.title||pageKey(p)))}</strong><span>${esc(plain(p.markdown).replace(/<[^>]*>/g,'').replace(/\[([^\]]+)\]\([^)]+\)/g,'$1').replace(/[#*_{}]/g,'').trim().slice(0,100))}</span></span>${app.icons.right}</button>`).join('')||'<div class="empty-state"><h2>Ничего не найдено</h2><p>Попробуй другое название.</p></div>'}</div>`;
  }
  function questLink(id){const q=questById.get(String(id));return q?`<button type="button" class="quest-related" data-quest="${id}">${app.image(itemFrom(props(q).icon))}<span>${esc(plain(props(q).name))}</span>${app.icons.right}</button>`:'';}
  const taskNames={'bq_standard:retrieval':'Получить предметы','bq_standard:crafting':'Создать предметы','bq_standard:checkbox':'Подтвердить выполнение','bq_standard:location':'Посетить место','bq_standard:fluid':'Собрать жидкость','bq_standard:kill':'Победить существ','bq_standard:meeting':'Встретить существо','bq_standard:scoreboard':'Выполнить условие','bq_standard:xp':'Получить опыт','bq_standard:advancement':'Получить достижение','bq_standard:hunt':'Охота'};
  function facts(record){const labels={amount:'Количество',required:'Нужно',target:'Цель',entity:'Существо',entityID:'Существо',mob:'Существо',dimension:'Измерение',dim:'Измерение',x:'X',y:'Y',z:'Z',range:'Радиус',radius:'Радиус',research:'Исследование',researchID:'Исследование',energy:'Энергия',xp:'Опыт',levels:'Уровни',level:'Уровень',duration:'Длительность',fluid:'Жидкость',name:'Название',description:'Описание'};return Object.entries(record).filter(([k,v])=>k in labels&&['string','number'].includes(typeof v)&&v!=='').map(([k,v])=>`<div class="quest-fact"><span>${labels[k]}</span><span>${esc(plain(v))}</span></div>`).join('');}
  function taskView(t){return `<section class="quest-task"><h4>${esc(taskNames[t.taskID]||'Условие задания')}</h4>${t.consume||t.autoConsume?'<p class="quest-note">Предметы будут израсходованы при сдаче.</p>':''}${(t.requiredItems||t.items||[]).map(s=>itemButton(s)).join('')}${facts(t)}${t.taskID==='bq_standard:checkbox'?'<p class="quest-note">Подтверждается в квестовой книге в игре.</p>':''}</section>`;}
  function detail(entity){
    if(entity.kind==='quest'){
      const q=questById.get(entity.id);if(!q)return header('Квест не найден','Квесты','map');const p=props(q),children=quests.filter(x=>(x.preRequisites||[]).includes(q.questID));
      return `${header(p.name,'Квесты','map')}<div class="knowledge-detail"><div class="quest-description">${markdown(p.desc||'')}</div><button type="button" class="complete-quest${completed.has(entity.id)?' checked':''}" data-complete-quest="${entity.id}" aria-pressed="${completed.has(entity.id)}">${completed.has(entity.id)?'✓ Отмечен выполненным':'Отметить выполненным'}</button>${q.preRequisites?.length?`<section class="knowledge-section"><h3>Сначала${p.questLogic==='OR'?' · любой из квестов':''}</h3>${q.preRequisites.map(questLink).join('')}</section>`:''}<section class="knowledge-section"><h3>Задания${p.taskLogic==='OR'?' · любое из условий':''}</h3>${(q.tasks||[]).map(taskView).join('')||'<p class="quest-note">Дополнительных заданий нет.</p>'}</section><section class="knowledge-section"><h3>Награды</h3>${(q.rewards||[]).map(r=>`<div class="quest-reward">${r.rewardID?.includes('choice')?'<p class="quest-note">Выбери одну награду</p>':''}${(r.rewards||r.items||[]).map(s=>itemButton(s)).join('')}${facts(r)}</div>`).join('')||'<p class="quest-note">Награда не указана.</p>'}</section>${children.length?`<section class="knowledge-section"><h3>Дальше</h3>${children.map(x=>questLink(x.questID)).join('')}</section>`:''}</div>`;
    }
    const page=pageById.get(entity.id);if(!page)return header('Материал не найден','Библиотека');return `${header(page.metadata?.title||entity.id,page.kind==='guide'?'Гайд':'Вики')}<article class="knowledge-detail guide-article">${markdown(page.markdown)}</article>`;
  }
  function inline(source){
    const held=[];const hold=html=>`\u0001${held.push(html)-1}\u0002`;
    let text=plain(source).replace(/<item\s+([^>]+?)(?:\/\s*>|>.*?<\/item>)/g,(_,attrs)=>{const get=name=>new RegExp(`(?:^|\\s)${name}=(?:"([^"]*)"|'([^']*)')`).exec(attrs);const id=get('id'),meta=get('meta'),nbt=get('nbt');return hold(itemButton({id:id?.[1]||id?.[2],meta:meta?.[1]||meta?.[2],nbt:nbt?.[1]||nbt?.[2]},1,'inline-item'));});
    text=text.replace(/<hotkey\s+bind=["']([^"']+)["']\s*\/>/g,(_,key)=>hold(`<kbd>${esc({'key.use':'ПКМ','key.attack':'ЛКМ','key.sneak':'Shift','key.inventory':'E','key.jump':'Пробел'}[key]||key.replace('key.',''))}</kbd>`));
    text=text.replace(/<tooltip\s+content="([^"]*)">(.*?)<\/tooltip>/g,(_,tip,label)=>hold(`<abbr title="${esc(tip.replace(/\\n/g,'\n'))}">${esc(label)}</abbr>`));
    text=text.replace(/<badge[^>]*>(.*?)<\/badge>/g,(_,label)=>hold(`<span class="guide-badge">${esc(label)}</span>`));
    text=text.replace(/<br\s*\/?>/g,'\n').replace(/<[^>]*>/g,'');
    text=esc(text).replace(/`([^`]+)`/g,'<code>$1</code>').replace(/\*\*([^*]+)\*\*/g,'<strong>$1</strong>').replace(/\*([^*]+)\*/g,'<em>$1</em>');
    text=text.replace(/\[([^\]]+)\]\(([^)]+)\)/g,(_,label,url)=>{if(url.startsWith('guide:')){const [id,anchor]=url.slice(6).split('#');return `<button type="button" class="guide-link" data-guide="${id}"${anchor?` data-anchor="${anchor}"`:''}>${label}</button>`;}if(/^https?:\/\//.test(url))return `<a href="${url}" target="_blank" rel="noopener noreferrer">${label}</a>`;return label;});
    return text.replace(/\u0001(\d+)\u0002/g,(_,index)=>held[Number(index)]).replace(/\n/g,'<br>');
  }
  function markdown(source){
    const rows=plain(source).split(/\r?\n/),out=[];let paragraph=[],table=[],list=[],code=false,codeLines=[];
    const flush=()=>{if(paragraph.length){out.push(`<p>${inline(paragraph.join(' '))}</p>`);paragraph=[];}if(list.length){out.push(`<ul>${list.map(x=>`<li>${inline(x)}</li>`).join('')}</ul>`);list=[];}if(table.length){const cells=row=>row.trim().replace(/^\||\|$/g,'').split('|');const content=table.filter(x=>!/^\s*\|?[\s:|-]+\|\s*$/.test(x));out.push(`<div class="guide-table"><table>${content.map((r,i)=>`<tr>${cells(r).map(c=>`<${i?'td':'th'}>${inline(c.trim())}</${i?'td':'th'}>`).join('')}</tr>`).join('')}</table></div>`);table=[];}};
    for(const row of rows){if(row.startsWith('```')){flush();if(code){out.push(`<pre><code>${esc(codeLines.join('\n'))}</code></pre>`);codeLines=[];}code=!code;continue;}if(code){codeLines.push(row);continue;}
      if(row.startsWith(':::')){flush();continue;}
      const heading=/^(#{1,6})\s+(.+)$/.exec(row);if(heading){flush();const anchor=/\{#([^\s}]+)/.exec(heading[2]);const title=heading[2].replace(/\s*\{.*\}\s*$/,'');const level=Math.min(4,heading[1].length+1);out.push(`<h${level}${anchor?` id="guide-${esc(anchor[1])}"`:''}>${inline(title)}</h${level}>`);continue;}
      if(row.trim().startsWith('|')){if(paragraph.length||list.length)flush();table.push(row);continue;}
      if(/^\s*[-*]\s+/.test(row)||/^\d+\.\s/.test(row)){if(paragraph.length||table.length)flush();list.push(row.replace(/^\s*(?:[-*]|\d+\.)\s+/,''));continue;}
      if(!row.trim()){flush();continue;}if(row.startsWith('> ')){flush();out.push(`<blockquote>${inline(row.slice(2))}</blockquote>`);continue;}paragraph.push(row);
    }flush();return out.join('');
  }
  document.addEventListener('click',async event=>{
    const b=event.target.closest('button');if(!b)return;
    if(b.hasAttribute('data-knowledge-retry')){error=false;ensure();return;}
    if(b.hasAttribute('data-map-fit'))fitMap();if(b.dataset.mapZoom)zoom(Number(b.dataset.mapZoom)>0?1.35:1/1.35);
    if(b.hasAttribute('data-knowledge-more')){app.state.limit+=150;renderView();}
    if(b.dataset.completeQuest){const id=b.dataset.completeQuest;completed.has(id)?completed.delete(id):completed.add(id);try{localStorage.setItem('uniland.completedQuests',JSON.stringify([...completed]));}catch{}app.renderInspector();const node=$('quest-world')?.querySelector(`[data-quest="${id}"]`);node?.classList.toggle('completed',completed.has(id));}
    if(b.dataset.quest){if(preventClick){preventClick=false;return;}await ensure();const id=b.dataset.quest;const current=lines.find(l=>String(l.lineID)===app.state.mod);if(app.state.view!=='quests')app.setView('quests');if(!current?.quests.some(x=>String(x.id)===id)){const line=lines.find(l=>l.quests.some(x=>String(x.id)===id));if(line){app.state.mod=String(line.lineID);configureFilter();renderView();}}app.selectEntity('quest',id);}
    if(b.dataset.guide){await ensure();if(app.state.view!=='guides')app.setView('guides');app.selectEntity('guide',b.dataset.guide);if(b.dataset.anchor)requestAnimationFrame(()=>$(`guide-${b.dataset.anchor}`)?.scrollIntoView({block:'start',behavior:'smooth'}));}
  });
  document.addEventListener('wheel',event=>{const map=event.target.closest('#quest-map');if(!map)return;event.preventDefault();const rect=map.getBoundingClientRect();zoom(Math.exp(-event.deltaY*.0015),event.clientX-rect.left,event.clientY-rect.top);},{passive:false});
  document.addEventListener('pointerdown',event=>{const map=event.target.closest('#quest-map');if(!map||event.button!==0)return;drag={id:event.pointerId,x:event.clientX,y:event.clientY,originX:mapState.x,originY:mapState.y,moved:false};preventClick=false;});
  document.addEventListener('pointermove',event=>{if(!drag||drag.id!==event.pointerId)return;const dx=event.clientX-drag.x,dy=event.clientY-drag.y;if(Math.abs(dx)+Math.abs(dy)>5){drag.moved=true;$('quest-map')?.setPointerCapture(event.pointerId);}if(drag.moved){mapState.x=drag.originX+dx;mapState.y=drag.originY+dy;transformMap();}});
  document.addEventListener('pointerup',event=>{if(drag?.id===event.pointerId){preventClick=drag.moved;drag=null;}});
  document.addEventListener('pointercancel',()=>{drag=null;});
  window.addEventListener('resize',()=>{if(app.state.view==='quests')fitMap();});
  window.UniLandKnowledge={ensure,configureFilter,renderView,detail,highlightSelection,markdown};
})();
