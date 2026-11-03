'use strict';
(() => {
  const app=window.UniLand,$=id=>document.getElementById(id),esc=app.esc;
  const plain=value=>String(value??'').replace(/§./g,'');
  let loading=null,ready=false,error=false,quests=[],lines=[],pages=[],questById=new Map(),pageById=new Map(),itemVariants=new Map();
  let mapState={chapter:null,transform:null,size:null},mapViewport=null,mapPositions=new Map();
  const questSearchText=new Map(),guideSearchText=new Map(),guideExcerpts=new Map();
  let savedCompleted=[];try{const stored=JSON.parse(localStorage.getItem('uniland.completedQuests')||'[]');if(Array.isArray(stored))savedCompleted=stored;}catch{}
  const completed=new Set(savedCompleted.map(String));
  const props=q=>q?.properties?.betterquesting||{};
  const pageKey=p=>p.metadata?.id||p.resource;
  function indexItems(){itemVariants=new Map();questSearchText.clear();for(const item of app.items.values()){if(!itemVariants.has(item.registryId))itemVariants.set(item.registryId,[]);itemVariants.get(item.registryId).push(item);}}
  window.addEventListener('uniland-ready',()=>{
    indexItems();
    if(ready&&['quests','guides'].includes(app.state.view)){
      app.renderCatalog();
      if(app.state.entity)app.renderInspector();
    }
  });
  async function ensure(){
    if(ready)return;if(loading)return loading;
    loading=(async()=>{try{
      const responses=await Promise.all(['quests','quest-lines','knowledge'].map(async name=>{const file=app.dataUrl(name);const r=await fetch(file,{cache:'no-cache'});if(!r.ok)throw new Error(`HTTP ${r.status}: ${r.url}`);return r.json();}));
      [quests,lines]=responses;pages=responses[2].pages;
      questById=new Map(quests.map(q=>[String(q.questID),q]));lines.sort((a,b)=>a.order-b.order);
      pageById=new Map(pages.map(p=>[pageKey(p),p]));guideSearchText.clear();guideExcerpts.clear();indexItems();ready=true;error=false;configureFilter();
    }catch(reason){console.error('[UniLand] Ошибка загрузки квестов и гайдов',reason);error=true;}finally{loading=null;if(app.state.view!=='catalog')app.renderCatalog();}})();return loading;
  }
  function configureFilter(){
    const filter=$('mod-filter');
    if(app.state.view==='quests'){
      filter.innerHTML=lines.map(line=>`<option value="${line.lineID}">${esc(plain(props(line).name))}</option>`).join('');
      if(!lines.some(x=>String(x.lineID)===app.state.mod))app.state.mod=String(lines.find(x=>String(x.lineID)===mapState.chapter)?.lineID??lines[0]?.lineID??'');
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
    host.setAttribute('aria-busy',String(!ready&&!error));
    if(app.state.view!=='quests')rememberMap();
    if(!ready){host.innerHTML=`<div class="empty-state"><h2>${error?'Не удалось загрузить материалы':'Загрузка…'}</h2>${error?'<button type="button" class="text-button" data-knowledge-retry>Повторить</button>':''}</div>`;if(!error)ensure();return;}
    if(app.state.view==='quests')renderQuests(host);else renderGuides(host);
  }
  function queryTokens(){return app.norm(app.state.query).split(/\s+/).filter(Boolean);}
  function questText(quest){const id=String(quest.questID);if(!questSearchText.has(id))questSearchText.set(id,app.norm([props(quest).name,props(quest).desc,...(quest.tasks||[]).flatMap(task=>(task.requiredItems||[]).map(item=>itemFrom(item)?.name||item.id))].join(' ')));return questSearchText.get(id);}
  function guideText(page){const id=pageKey(page);if(!guideSearchText.has(id))guideSearchText.set(id,app.norm(`${page.metadata?.title||''} ${page.markdown} ${page.metadata?.id||''}`));return guideSearchText.get(id);}
  function guideExcerpt(page){
    const id=pageKey(page);
    if(!guideExcerpts.has(id))guideExcerpts.set(id,plain(page.markdown)
      .replace(/```[\s\S]*?```|~~~[\s\S]*?~~~/g,' ')
      .replace(/\{%[\s\S]*?%\}/g,' ')
      .replace(/^[ \t]*:::[^\r\n]*/gm,'')
      .replace(/\{#[^}\r\n]*\}/g,'')
      .replace(/!\[[^\]]*\]\([^)]*\)/g,' ')
      .replace(/<[^>]*>/g,'')
      .replace(/\[([^\]]+)\]\([^)]+\)/g,'$1')
      .replace(/\\(?:\r?\n|([\\`*{}\[\]()#+.!_>~-]))/g,(_,escaped)=>escaped||' ')
      .replace(/^[ \t]*(?:#{1,6}\s+|>\s*|[-*+]\s+|\d+[.)]\s+)/gm,'')
      .replace(/[#*_`~]/g,'')
      .replace(/\s+/g,' ')
      .replace(/\s+([,.;:!?])/g,'$1')
      .trim().slice(0,100));
    return guideExcerpts.get(id);
  }
  function rememberMap(){if(!mapViewport)return;mapState.transform=mapViewport.getTransform();mapState.size=mapViewport.getViewportSize();mapViewport.destroy();mapViewport=null;}
  function renderQuests(host){
    rememberMap();
    const line=lines.find(x=>String(x.lineID)===app.state.mod)||lines[0];if(!line){host.innerHTML='<div class="empty-state"><h2>Квестов пока нет</h2></div>';return;}
    const nodes=line.quests.filter(n=>questById.has(String(n.id))),ids=new Set(nodes.map(n=>String(n.id)));
    const tokens=queryTokens(),searching=tokens.length>0,found=searching?quests.filter(q=>tokens.every(word=>questText(q).includes(word))):[];
    $('result-count').textContent=searching?`${found.length} найдено`:`${nodes.length} квестов`;$('page-title').textContent='Квесты';
    if(!nodes.length){host.innerHTML='<div class="empty-state"><h2>В этой главе пока нет квестов</h2></div>';return;}
    const minX=Math.min(...nodes.map(n=>n.x))-24,minY=Math.min(...nodes.map(n=>n.y))-24;
    const width=(Math.max(...nodes.map(n=>n.x+n.sizeX))-minX+24)*3,height=(Math.max(...nodes.map(n=>n.y+n.sizeY))-minY+24)*3;
    const position=new Map(nodes.map(n=>[String(n.id),{x:(n.x-minX)*3,y:(n.y-minY)*3,w:n.sizeX*3,h:n.sizeY*3}]));mapPositions=position;
    const foundIds=new Set(found.map(q=>String(q.questID)));
    const links=nodes.flatMap(node=>(questById.get(String(node.id)).preRequisites||[]).filter(id=>ids.has(String(id))).map(id=>{
      const a=position.get(String(id)),b=position.get(String(node.id));return `<path d="M${a.x+a.w/2},${a.y+a.h/2} L${b.x+b.w/2},${b.y+b.h/2}"/>`;
    })).join('');
    host.innerHTML=`<div class="knowledge-topline"><h2>${esc(plain(props(line).name))}</h2><div class="map-controls"><button class="icon-button" type="button" data-map-zoom="-1" aria-label="Уменьшить">−</button><button class="map-fit" type="button" data-map-fit>Вся глава</button><button class="icon-button" type="button" data-map-zoom="1" aria-label="Увеличить">+</button></div></div>${searching?`<div class="quest-search-results">${found.slice(0,100).map(q=>`<button type="button" data-quest="${q.questID}">${app.image(itemFrom(props(q).icon))}<span>${esc(plain(props(q).name))}</span></button>`).join('')||'<p>Ничего не найдено</p>'}${found.length>100?'<p>Уточни поиск, чтобы увидеть остальные квесты.</p>':''}</div>`:''}<div class="quest-map" id="quest-map" tabindex="0" role="region" aria-label="Карта квестов. Один палец перемещает карту, два меняют масштаб. Стрелки — перемещение, плюс и минус — масштаб, Home — вся глава."><div class="quest-world" id="quest-world" style="width:${width}px;height:${height}px"><svg class="quest-links" viewBox="0 0 ${width} ${height}" aria-hidden="true">${links}</svg>${nodes.map(node=>{const q=questById.get(String(node.id)),p=position.get(String(node.id));return `<button type="button" class="quest-node${completed.has(String(node.id))?' completed':''}${searching&&!foundIds.has(String(node.id))?' dimmed':''}" data-quest="${node.id}" style="left:${p.x}px;top:${p.y}px;width:${p.w}px;height:${p.h}px" title="${esc(plain(props(q).name))}" aria-label="${esc(plain(props(q).name))}">${app.image(itemFrom(props(q).icon))}<span class="quest-node-name">${esc(plain(props(q).name))}</span></button>`;}).join('')}</div></div>`;
    const chapter=String(line.lineID),changed=mapState.chapter!==chapter,map=$('quest-map');
    let initialTransform=changed?undefined:mapState.transform;
    if(initialTransform&&mapState.size)initialTransform={...initialTransform,x:initialTransform.x+(map.clientWidth-mapState.size.width)/2,y:initialTransform.y+(map.clientHeight-mapState.size.height)/2};
    mapState.chapter=chapter;
    mapViewport=window.UniLandViewport.create({viewport:map,world:$('quest-world'),width,height,minScale:.08,maxScale:5,fitMaxScale:1.2,padding:20,fitOnResize:false,initialTransform,onChange:(transform,size)=>{mapState.transform=transform;mapState.size=size;}});
    highlightSelection();
  }
  function fitMap(){mapViewport?.fit();}
  function zoom(factor){mapViewport?.zoomBy(factor);}
  function revealQuest(id){
    id=String(id);
    if(!ready||app.state.view!=='quests'||!questById.has(id))return false;
    const hasQuest=line=>line.quests.some(node=>String(node.id)===id);
    const line=lines.find(line=>String(line.lineID)===app.state.mod&&hasQuest(line))||lines.find(hasQuest);
    if(!line)return false;
    const chapter=String(line.lineID),changed=app.state.mod!==chapter||mapState.chapter!==chapter;
    app.state.mod=chapter;configureFilter();
    if(changed||!mapViewport||!$('quest-map'))renderView();
    const position=mapPositions.get(id);
    if(position&&mapViewport){
      const transform=mapViewport.getTransform(),size=mapViewport.getViewportSize(),margin=Math.min(24,size.width/8,size.height/8);
      const left=position.x*transform.scale+transform.x,top=position.y*transform.scale+transform.y;
      if(left<margin||top<margin||left+position.w*transform.scale>size.width-margin||top+position.h*transform.scale>size.height-margin)mapViewport.setTransform({x:size.width/2-(position.x+position.w/2)*transform.scale,y:size.height/2-(position.y+position.h/2)*transform.scale,scale:transform.scale});
      $('quest-world').querySelectorAll('[data-quest]').forEach(node=>{if(node.dataset.quest===id)node.classList.remove('dimmed');});
    }
    return true;
  }
  function highlightSelection(){document.querySelectorAll('.quest-node').forEach(node=>node.classList.toggle('selected',app.state.entity?.kind==='quest'&&node.dataset.quest===app.state.entity.id));}
  function renderGuides(host){
    const tokens=queryTokens(),found=pages.filter(p=>(!app.state.mod||p.kind===app.state.mod)&&tokens.every(word=>guideText(p).includes(word)));
    $('result-count').textContent=`${found.length} материалов`;$('page-title').textContent='Гайды';
    const size=app.capacity(true);app.pagination(found.length,size);
    host.innerHTML=`<div class="knowledge-topline"><h2>${app.state.mod==='wiki'?'Вики':app.state.mod==='guide'?'Гайды':'Библиотека'}</h2></div><div class="guide-grid">${found.slice(app.state.page*size,(app.state.page+1)*size).map(p=>`<button class="guide-card" type="button" data-guide="${esc(pageKey(p))}">${app.image(itemFrom(p.metadata?.icon))}<span class="guide-card-copy"><span class="detail-eyebrow">${p.kind==='guide'?'Гайд':'Вики'}</span><strong>${esc(plain(p.metadata?.title||pageKey(p)))}</strong><span>${esc(guideExcerpt(p))}</span></span>${app.icons.right}</button>`).join('')||'<div class="empty-state"><h2>Ничего не найдено</h2><p>Попробуй другое название.</p></div>'}</div>`;
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
    if(b.hasAttribute('data-knowledge-retry')){error=false;ensure();app.renderCatalog();return;}
    if(b.hasAttribute('data-map-fit'))fitMap();if(b.dataset.mapZoom)zoom(Number(b.dataset.mapZoom)>0?1.35:1/1.35);
    if(b.hasAttribute('data-knowledge-more')){app.state.limit+=150;renderView();}
    if(b.dataset.completeQuest){const id=b.dataset.completeQuest;completed.has(id)?completed.delete(id):completed.add(id);try{localStorage.setItem('uniland.completedQuests',JSON.stringify([...completed]));}catch{}app.renderInspector();const node=$('quest-world')?.querySelector(`[data-quest="${id}"]`);node?.classList.toggle('completed',completed.has(id));}
    if(b.dataset.quest){await ensure();const id=b.dataset.quest;if(app.state.view!=='quests')app.setView('quests');revealQuest(id);app.selectEntity('quest',id);}
    if(b.dataset.guide){await ensure();if(app.state.view!=='guides')app.setView('guides');app.selectEntity('guide',b.dataset.guide);if(b.dataset.anchor)requestAnimationFrame(()=>$(`guide-${b.dataset.anchor}`)?.scrollIntoView({block:'start',behavior:'smooth'}));}
  });
  window.UniLandKnowledge={ensure,configureFilter,renderView,detail,revealQuest,highlightSelection,markdown};
})();
