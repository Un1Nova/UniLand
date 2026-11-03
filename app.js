'use strict';
(() => {
  const $ = (id) => document.getElementById(id);
  const svg = (body) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
  const icons = {
    map:svg('<circle cx="5" cy="6" r="2"/><circle cx="19" cy="6" r="2"/><circle cx="12" cy="19" r="2"/><path d="M7 6h10M6 8l5 9m7-9-5 9"/>'),
    book:svg('<path d="M12 5v15M3 4c4-1 6 0 9 2 3-2 5-3 9-2v15c-4-1-6 0-9 2-3-2-5-3-9-2V4Z"/>'),
    cube:svg('<path d="m12 3 9 5v9l-9 5-9-5V8l9-5ZM3 8l9 5 9-5m-9 5v9M7.5 5.5l9 5"/>'),
    search:svg('<circle cx="10.5" cy="10.5" r="6.8"/><path d="m16 16 4.5 4.5"/>'),
    star:svg('<path d="m12 3 2.8 5.7 6.3.9-4.5 4.4 1.1 6.2-5.7-3-5.7 3 1.1-6.2L3.2 9.6l6-.9L12 3Z"/>'),
    close:svg('<path d="m6 6 12 12M6 18 18 6"/>'),
    down:svg('<path d="m6 9 6 6 6-6"/>'),
    left:svg('<path d="m15 5-7 7 7 7"/>'),
    right:svg('<path d="m9 5 7 7-7 7"/>'),
    arrow:svg('<path d="M3 12h17m-6-6 6 6-6 6"/>'),
    external:svg('<path d="M14 3h7v7m0-7L10 14M10 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-5"/>')
  };
  const esc = (value) => String(value ?? '').replace(/[&<>"']/g,(c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const numberFormat = new Intl.NumberFormat('ru-RU',{maximumSignificantDigits:15});
  const num = (value) => numberFormat.format(value);
  const norm = (value) => String(value ?? '').toLocaleLowerCase('ru').replace(/ё/g,'е').normalize('NFKD').replace(/[\u0300-\u036f]/g,'').trim();
  const plural = (n,a,b,c) => { const m=Math.abs(n)%100,d=m%10; return m>=11&&m<=14?c:d===1?a:d>=2&&d<=4?b:c; };
  const itemsLabel = (n) => `${num(n)} ${plural(n,'предмет','предмета','предметов')}`;
  const positive = (value) => typeof value==='number'&&Number.isFinite(value)&&value>0?value:1;
  const amount = (stack) => `${num(positive(stack.count))}${stack.unit?' '+stack.unit:''}`;
  const chance = (value) => typeof value==='number'&&Number.isFinite(value)&&value>=0&&value<=1?`${num(value*100)}%`:'';
  const knownGrid = (recipe) => Number.isInteger(recipe.width)&&Number.isInteger(recipe.height)&&recipe.inputs.every(stack=>Number.isInteger(stack.slot));
  const strings = (value) => Array.isArray(value)?value.filter((v)=>typeof v==='string'):[];
  const safeUrl = (value,image=false) => {
    if(typeof value!=='string'||value.length>(image?1200000:6000))return '';
    if(image&&/^data:image\/(png|jpeg|webp|gif);base64,[a-z0-9+/=\s]+$/i.test(value))return value;
    try{return ['https:','http:'].includes(new URL(value,location.href).protocol)?value:'';}catch{return '';}
  };
  const readLocal = (key,fallback) => {try{return JSON.parse(localStorage.getItem(key))??fallback;}catch{return fallback;}};
  const writeLocal = (key,value) => {try{localStorage.setItem(key,JSON.stringify(value));}catch{}};
  const dataFiles = {catalog:'catalog.json',quests:'data/quests.json','quest-lines':'data/quest-lines.json',knowledge:'data/knowledge.json'};
  const dataUrl = (name) => document.querySelector(`meta[name="uniland-${name}"]`)?.getAttribute('content') || dataFiles[name];
  const emptyCatalog = (loadFailed=false) => ({schemaVersion:1,meta:{status:'unavailable',loadFailed},mods:[],items:[],recipes:[]});
  let catalog=emptyCatalog(),items=new Map(),mods=new Map(),searchIndex=new Map(),byOutput=new Map(),byInput=new Map();
  let hoverItem=null,searchTimer,drawerOpen=false,returnFocus=null,returnItem=null;
  const favorites=readLocal('atlas.favorites',[]);
  const state={view:'catalog',entity:null,lastEntity:null,page:0,query:'',mod:'',favoritesOnly:false,selected:null,tab:'recipes',recipeIndex:0,limit:150,trail:[],favorites:new Set(Array.isArray(favorites)?favorites.filter(v=>typeof v==='string'):[])};
  document.querySelectorAll('[data-icon]').forEach(node=>{node.innerHTML=icons[node.dataset.icon]||'';});
  function validateCatalog(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Некорректный объект каталога.');
    if (raw.schemaVersion !== 1) throw new Error('Неподдерживаемая версия каталога.');
    if (!Array.isArray(raw.items) || !Array.isArray(raw.recipes)) throw new Error('В каталоге должны быть массивы items и recipes.');
    if (raw.items.length > 100000 || raw.recipes.length > 250000) throw new Error('Слишком большой каталог: максимум 100 000 предметов и 250 000 рецептов.');
    const ids = new Set();
    for (const item of raw.items) {
      if (!item || typeof item.id !== 'string' || !item.id || item.id.length > 1024 || typeof item.name !== 'string' || !item.name || item.name.length > 1000) throw new Error('У каждого предмета нужны строковые id и name.');
      if (ids.has(item.id)) throw new Error(`Повторяется ID предмета: ${item.id.slice(0,80)}`);
      ids.add(item.id);
    }
    const recipeIds = new Set();
    for (const recipe of raw.recipes) {
      if (!recipe || typeof recipe.id !== 'string' || !recipe.id || recipeIds.has(recipe.id)) throw new Error('Каждому рецепту нужен уникальный строковый id.');
      recipeIds.add(recipe.id);
      if(typeof recipe.type!=='string'||!recipe.type)throw new Error('У рецепта должен быть тип.');
      if (!Array.isArray(recipe.inputs) || !Array.isArray(recipe.outputs) || (!recipe.outputs.length && !(recipe.operation==='native-rule'&&recipe.sources?.length&&recipe.detailsFile))) throw new Error(`У рецепта ${recipe.id.slice(0,60)} нужны inputs и непустой outputs.`);
      if (recipe.inputs.length > 512 || recipe.outputs.length > 128) throw new Error('Слишком много ингредиентов в одном рецепте.');
      for (const dimension of ['width','height']) {
        if (recipe[dimension] !== undefined && (!Number.isInteger(recipe[dimension]) || recipe[dimension] < 1 || recipe[dimension] > 9)) throw new Error('Размер сетки рецепта должен быть от 1 до 9 ячеек по каждой стороне.');
      }
      const explicitGrid = Number.isInteger(recipe.width) && Number.isInteger(recipe.height);
      if((recipe.width!==undefined)!==(recipe.height!==undefined))throw new Error('Для сетки нужны оба размера.');
      const capacity = explicitGrid ? recipe.width * recipe.height : null;
      const occupied = new Set();
      for (const stack of recipe.inputs) {
        if (stack?.slot === undefined) continue;
        if (!explicitGrid || !Number.isSafeInteger(stack.slot) || stack.slot < 0 || stack.slot >= capacity) throw new Error(`Ячейка рецепта ${recipe.id.slice(0,60)} выходит за границы сетки.`);
        if (occupied.has(stack.slot)) throw new Error(`В рецепте ${recipe.id.slice(0,60)} повторяется ячейка ингредиента.`);
        occupied.add(stack.slot);
      }
      if (explicitGrid && recipe.inputs.length > capacity) throw new Error('В указанной сетке не хватает ячеек для всех ингредиентов.');
      for (const stack of [...recipe.inputs, ...recipe.outputs]) {
        if (!stack || typeof stack.itemId !== 'string' || !ids.has(stack.itemId)) throw new Error(`В рецепте ${recipe.id.slice(0,60)} есть предмет, отсутствующий в items.`);
        if (stack.count !== undefined && (typeof stack.count !== 'number' || !Number.isFinite(stack.count) || stack.count <= 0)) throw new Error('Количество ингредиента должно быть положительным числом.');
        if (stack.unit !== undefined && (typeof stack.unit !== 'string' || stack.unit.length > 80)) throw new Error('Единица измерения должна быть короткой строкой.');
        if (stack.chance !== undefined && (typeof stack.chance !== 'number' || !Number.isFinite(stack.chance) || stack.chance < 0 || stack.chance > 1)) throw new Error('Вероятность результата должна быть числом от 0 до 1: например, 0.01 означает 1%.');
        if (stack.alternatives !== undefined && (!Array.isArray(stack.alternatives) || stack.alternatives.length > 2048 || stack.alternatives.some((id) => typeof id !== 'string' || !ids.has(id)))) throw new Error('Все альтернативные ингредиенты должны быть перечислены в items.');
        if(stack.variants!==undefined&&(!Array.isArray(stack.variants)||stack.variants.some(v=>!ids.has(v.itemId)||typeof v.count!=='number'||!Number.isFinite(v.count)||v.count<=0)))throw new Error('Некорректные количества альтернатив.');
      }
    }
    if (raw.mods !== undefined && (!Array.isArray(raw.mods) || raw.mods.length > 10000)) throw new Error('Поле mods должно быть массивом модификаций.');
    const mods = (raw.mods || []).filter((mod) => mod && typeof mod.id === 'string' && typeof mod.name === 'string');
    return {...raw,mods,meta:raw.meta && typeof raw.meta === 'object' ? raw.meta : {status:'partial'}};
  }

  function image(item) {
    const src=safeUrl(item?.icon,true);
    return src?`<img class="item-icon" src="${esc(src)}" alt="" loading="lazy" decoding="async">`:`<span class="item-icon missing-icon" title="Нет иконки">${icons.cube}</span>`;
  }
  document.addEventListener('error',(event)=>{
    const target=event.target;
    if(!(target instanceof HTMLImageElement)||!target.classList.contains('item-icon'))return;
    const fallback=document.createElement('span');fallback.className='item-icon missing-icon';fallback.title='Нет иконки';fallback.innerHTML=icons.cube;target.replaceWith(fallback);
  },true);
  function indexCatalog(){
    items=new Map(catalog.items.map(item=>[item.id,item]));mods=new Map(catalog.mods.map(mod=>[mod.id,{...mod,count:0}]));byOutput=new Map();byInput=new Map();searchIndex=new Map();
    for(const item of catalog.items){
      const modId=item.modId||'unknown';
      if(!mods.has(modId))mods.set(modId,{id:modId,name:modId==='unknown'?'Другие':modId,count:0});
      const mod=mods.get(modId);mod.count++;
      searchIndex.set(item.id,{text:norm([item.name,item.englishName,item.id,...strings(item.tags),mod.name,mod.id].join(' ')),mod:norm(`${mod.name} ${mod.id} ${item.id.split(':')[0]}`)});
    }
    const add=(map,id,recipe)=>{if(!map.has(id))map.set(id,[]);map.get(id).push(recipe);};
    for(const recipe of catalog.recipes){new Set(recipe.outputs.map(stack=>stack.itemId)).forEach(id=>add(byOutput,id,recipe));new Set(recipe.inputs.flatMap(stack=>[stack.itemId,...(stack.alternatives||[])])).forEach(id=>add(byInput,id,recipe));}
  }
  function applyCatalog(value){
    catalog=value;state.mod='';state.selected=null;state.trail=[];state.recipeIndex=0;state.limit=150;indexCatalog();
    $('mod-filter').innerHTML='<option value="">Все моды</option>'+[...mods.values()].filter(mod=>mod.count>0).sort((a,b)=>a.name.localeCompare(b.name,'ru')).map(mod=>`<option value="${esc(mod.id)}">${esc(mod.name)}</option>`).join('');
    $('content').classList.toggle('empty-catalog',!catalog.items.length);renderCatalog();renderInspector();
  }
  function results(){const tokens=norm(state.query).split(/\s+/).filter(Boolean);return catalog.items.filter(item=>{
    if(state.mod&&(item.modId||'unknown')!==state.mod)return false;
    if(state.favoritesOnly&&!state.favorites.has(item.id))return false;
    const entry=searchIndex.get(item.id);return tokens.every(token=>token.startsWith('@')?entry.mod.includes(token.slice(1)):entry.text.includes(token));
  });}
  function renderCatalog(){
    for(const [id,view] of [['catalog-nav','catalog'],['quests-nav','quests'],['guides-nav','guides']]){const active=state.view===view&&!state.favoritesOnly;$(id).classList.toggle('active',active);$(id).setAttribute('aria-pressed',String(active));}
    $('favorite-items').classList.toggle('active',state.view==='catalog'&&state.favoritesOnly);
    $('items-grid').hidden=state.view!=='catalog';$('knowledge-view').hidden=state.view==='catalog';
    $('content').classList.toggle('knowledge-mode',state.view!=='catalog');
    $('content').classList.toggle('guide-mode',state.view==='guides');
    $('clear-search').hidden=!state.query;$('search-shortcut').hidden=!!state.query;
    if(state.view!=='catalog'){$('load-more').hidden=true;$('empty-state').hidden=true;$('catalog-pagination').hidden=true;window.UniLandKnowledge?.renderView();return;}
    const filtered=results();$('result-count').textContent=catalog.items.length?itemsLabel(filtered.length):'';
    $('page-title').textContent=state.favoritesOnly?'Избранное':'Крафты';$('catalog-nav').classList.toggle('active',!state.favoritesOnly);$('catalog-nav').setAttribute('aria-pressed',String(!state.favoritesOnly));
    $('favorite-items').classList.toggle('active',state.favoritesOnly);$('favorite-items').setAttribute('aria-pressed',String(state.favoritesOnly));$('favorite-items').title=state.favoritesOnly?'Показать все предметы':'Избранное';
    $('clear-search').hidden=!state.query;$('search-shortcut').hidden=!!state.query;
    const pageSize=capacity();pagination(filtered.length,pageSize);
    $('items-grid').innerHTML=filtered.slice(state.page*pageSize,(state.page+1)*pageSize).map(item=>`<article class="item-card${state.selected===item.id?' selected':''}" data-item="${esc(item.id)}"><button class="card-star${state.favorites.has(item.id)?' saved':''}" type="button" data-favorite="${esc(item.id)}" aria-label="${state.favorites.has(item.id)?'Убрать из избранного':'В избранное'}: ${esc(item.name)}" aria-pressed="${state.favorites.has(item.id)}">${icons.star}</button><button class="item-select" type="button" data-select="${esc(item.id)}" title="${esc(item.name)}\n${esc(item.id)}" aria-label="${esc(item.name)}">${image(item)}<span class="item-name">${esc(item.name)}</span></button></article>`).join('');
    $('load-more').hidden=true;$('empty-state').hidden=!!filtered.length;
    if(!filtered.length){
      let title='Ничего не найдено',text='Измени поиск или фильтр.',action='reset',button='Сбросить';
      if(!catalog.items.length){title=catalog.meta.loadFailed?'Не удалось загрузить рецепты':'Рецептов пока нет';text=catalog.meta.loadFailed?'Проверь подключение и повтори загрузку.':'Выгрузка текущей сборки ещё не опубликована.';action=catalog.meta.loadFailed?'reload':'';button=catalog.meta.loadFailed?'Повторить':'';}
      else if(state.favoritesOnly&&!state.query&&!state.mod){title='Пока пусто';text='Сохраняй предметы звёздочкой.';button='Все предметы';}
      $('empty-state').innerHTML=`<span>${icons.cube}</span><h2>${title}</h2><p>${text}</p>${action?`<button class="text-button" type="button" data-action="${action}">${button}</button>`:''}`;
    }
  }
  function capacity(guides=false){const box=$('catalog').getBoundingClientRect(),mobile=innerWidth<=700;const min=guides?240:innerWidth>=1440?94:mobile?74:86,gap=guides?10:mobile?6:8,padding=guides?32:mobile?20:24;const cols=guides&&mobile?1:Math.max(1,Math.floor((box.width-padding+gap)/(min+gap)));const row=guides?130:mobile?112:120;const rows=Math.max(1,Math.floor((box.height-(guides?116:24)-52+gap)/row));return cols*rows;}
  function pagination(total,size){const pages=Math.max(1,Math.ceil(total/size));state.page=Math.max(0,Math.min(state.page,pages-1));const host=$('catalog-pagination');host.hidden=!total;host.innerHTML=`<button class="icon-button" type="button" data-page="-1" aria-label="Предыдущая страница"${state.page===0?' disabled':''}>${icons.left}</button><span aria-live="polite">${state.page+1}<span> / ${pages}</span></span><button class="icon-button" type="button" data-page="1" aria-label="Следующая страница"${state.page===pages-1?' disabled':''}>${icons.right}</button>`;}
  function configureFilter(){
    if(state.view==='catalog'){$('mod-filter').innerHTML='<option value="">Все моды</option>'+[...mods.values()].filter(m=>m.count>0).sort((a,b)=>a.name.localeCompare(b.name,'ru')).map(m=>`<option value="${esc(m.id)}">${esc(m.name)}</option>`).join('');$('search-input').placeholder='Найти предмет или @мод';}
    else window.UniLandKnowledge?.configureFilter();
  }
  function setView(view){state.view=view;state.query='';state.mod='';state.favoritesOnly=false;state.limit=150;state.page=0;state.selected=null;state.entity=null;state.lastEntity=null;state.trail=[];$('search-input').value='';configureFilter();renderCatalog();renderInspector();const url=new URL(location.href);for(const key of ['item','quest','guide'])url.searchParams.delete(key);url.searchParams.set('view',view);history.replaceState(null,'',url);}
  function reset(){setView('catalog');}
  function favorite(id){
    if(!items.has(id))return;
    state.favorites.has(id)?state.favorites.delete(id):state.favorites.add(id);writeLocal('atlas.favorites',[...state.favorites]);
    const focused=document.activeElement?.dataset.favorite;const scroll=$('inspector').scrollTop;renderCatalog();if(state.selected===id){renderInspector();$('inspector').scrollTop=scroll;}
    if(focused){const target=[...document.querySelectorAll('[data-favorite]')].find(node=>node.dataset.favorite===focused&&!node.closest('[inert]'));target?.focus({preventScroll:true});}
  }
  function select(id,tab='recipes',remember=true){
    if(!items.has(id))return;
    if(state.entity)state.lastEntity=state.entity;state.entity=null;
    if(remember&&state.selected&&state.selected!==id)state.trail.push(state.selected);
    state.trail=state.trail.slice(-30);state.selected=id;state.tab=tab;state.recipeIndex=0;renderInspector();
    document.querySelectorAll('[data-item]').forEach(node=>node.classList.toggle('selected',node.dataset.item===id));
    const url=new URL(location.href);url.searchParams.set('item',id);history.replaceState(null,'',url);
  }
  function closeItem(){state.selected=null;state.entity=null;state.lastEntity=null;state.trail=[];renderInspector();document.querySelectorAll('.item-card.selected').forEach(node=>node.classList.remove('selected'));const url=new URL(location.href);for(const key of ['item','quest','guide'])url.searchParams.delete(key);history.replaceState(null,'',url);}
  function selectEntity(kind,id){state.selected=null;state.entity={kind,id:String(id)};state.lastEntity=null;state.trail=[];renderInspector();const url=new URL(location.href);url.searchParams.delete('item');url.searchParams.delete(kind==='quest'?'guide':'quest');url.searchParams.set(kind,id);url.searchParams.set('view',state.view);history.replaceState(null,'',url);window.UniLandKnowledge?.highlightSelection();}
  function cell(stack){
    if(!stack)return '<div class="craft-slot" aria-hidden="true"></div>';
    const item=items.get(stack.itemId),alternatives=(stack.alternatives||[]).filter(id=>id!==stack.itemId),count=positive(stack.count);
    const title=`${item?.name||stack.itemId} × ${amount(stack)}${chance(stack.chance)?' · '+chance(stack.chance):''}${alternatives.length?'\nИли: '+alternatives.map(id=>items.get(id)?.name||id).join(', '):''}`;
    return `<div class="craft-slot"><button type="button" data-select="${esc(stack.itemId)}" title="${esc(title)}" aria-label="${esc(title)}">${image(item)}${count!==1?`<span class="stack-count">${num(count)}</span>`:''}${alternatives.length?'<span class="alternative-dot"></span>':''}</button></div>`;
  }
  const typeNames={crafting:'Верстак',shaped:'Верстак',shapeless:'Бесформенный крафт',smelting:'Переплавка',furnace:'Печь',infusion:'Наполнение',alchemy:'Алхимия',mana:'Мана',assembly:'Сборка',machine:'Механизм'};
  function recipeView(recipe){
    const grid=knownGrid(recipe),width=grid?recipe.width:0;
    const slots=grid?Array(recipe.width*recipe.height).fill(null):[];
    if(grid)recipe.inputs.forEach(stack=>{slots[stack.slot]=stack;});
    const inputView=grid?`<div class="craft-grid" style="--cols:${width}">${slots.map(cell).join('')}</div>`:`<div class="ingredient-tray" aria-label="Ингредиенты">${recipe.inputs.map(cell).join('')}</div>`;
    const caption=recipe.type==='shapeless'?'Бесформенный':!grid&&['shaped','crafting'].includes(recipe.type)?'Расположение не указано':'';
    const grouped=new Map();for(const stack of recipe.inputs){const key=stack.itemId+'|'+(stack.alternatives||[]).join(',')+'|'+(stack.unit||'');if(grouped.has(key))grouped.get(key).count+=positive(stack.count);else grouped.set(key,{...stack,count:positive(stack.count)});}
    const ingredientRows=[...grouped.values()].map(stack=>`<button class="ingredient-row" type="button" data-select="${esc(stack.itemId)}">${image(items.get(stack.itemId))}<span>${esc(items.get(stack.itemId)?.name||stack.itemId)}</span><span class="ingredient-amount">× ${esc(amount(stack))}</span></button>${(stack.alternatives||[]).filter(id=>id!==stack.itemId).length?`<div class="alternatives"><span>или</span>${stack.alternatives.filter(id=>id!==stack.itemId).map(id=>`<button class="alternative-button" type="button" data-select="${esc(id)}">${image(items.get(id))}<span>${esc(items.get(id)?.name||id)}</span></button>`).join('')}</div>`:''}`).join('');
    const conditions=strings(recipe.conditions),source=safeUrl(recipe.sourceUrl),sourceImage=safeUrl(recipe.sourceImage,true);
    const verification=recipe.verification==='runtime'?'':recipe.verification==='example'?'Пример':recipe.verification==='documented'?'Из гайда · не проверено в игре':'Актуальность не подтверждена';
    return `${verification?`<p class="verification">${verification}</p>`:''}${caption?`<p class="layout-caption">${caption}</p>`:''}<div class="recipe-workspace${grid&&width>4?' large-grid':''}">${inputView}<span class="recipe-arrow">${icons.arrow}</span><div class="recipe-outputs">${recipe.outputs.map(cell).join('')}</div></div>${recipe.outputs.some(s=>s.unit||chance(s.chance))?`<div class="recipe-extra">${recipe.outputs.filter(s=>s.unit||chance(s.chance)).map(s=>`${esc(items.get(s.itemId)?.name||s.itemId)}: ${esc(amount(s))}${chance(s.chance)?' · '+chance(s.chance):''}`).join('<br>')}</div>`:''}${ingredientRows?`<details class="recipe-detail"><summary>Ингредиенты</summary>${ingredientRows}</details>`:''}${conditions.length||recipe.notes?`<details class="recipe-detail"><summary>Условия</summary><div class="recipe-extra">${conditions.map(c=>esc(c)).join('<br>')}${recipe.notes?`<p>${esc(recipe.notes)}</p>`:''}</div></details>`:''}${sourceImage?`<details class="recipe-detail"><summary>Исходная схема</summary><a href="${esc(sourceImage)}" target="_blank" rel="noopener noreferrer"><img class="source-image" src="${esc(sourceImage)}" alt="Схема рецепта" loading="lazy"></a></details>`:''}${source?`<a class="source-link" href="${esc(source)}" target="_blank" rel="noopener noreferrer">Источник ${icons.external}</a>`:''}`;
  }
  function renderInspector(){
    if(state.entity&&window.UniLandKnowledge){$('inspector').innerHTML=window.UniLandKnowledge.detail(state.entity);$('inspector').classList.add('is-open');$('inspector').scrollTop=0;syncOverlay();return;}
    const item=items.get(state.selected),focusedTab=$('inspector').contains(document.activeElement)?document.activeElement?.dataset.tab:null;
    if(!item){$('inspector').innerHTML='<div class="inspector-idle">Выбери предмет</div>';$('inspector').classList.remove('is-open');syncOverlay();return;}
    const own=byOutput.get(item.id)||[],used=byInput.get(item.id)||[],list=state.tab==='recipes'?own:used;
    state.recipeIndex=Math.max(0,Math.min(state.recipeIndex,list.length-1));const recipe=list[state.recipeIndex];
    const body=recipe?`<div class="recipe-heading"><h3>${esc(recipe.machine||(recipe.type==='shapeless'?'Верстак':typeNames[recipe.type])||recipe.title||recipe.type||'Рецепт')}</h3>${list.length>1?`<div class="recipe-pager"><button class="icon-button" type="button" data-step="-1" aria-label="Предыдущий рецепт"${!state.recipeIndex?' disabled':''}>${icons.left}</button><span>${state.recipeIndex+1}/${list.length}</span><button class="icon-button" type="button" data-step="1" aria-label="Следующий рецепт"${state.recipeIndex>=list.length-1?' disabled':''}>${icons.right}</button></div>`:''}</div>${recipeView(recipe)}`:`<p class="no-recipes">${state.tab==='recipes'?'Рецепт не загружен':'Применение не загружено'}</p>`;
    $('inspector').innerHTML=`<div class="inspector-nav"><button class="icon-button" type="button" data-action="back" aria-label="Назад"${!state.trail.length&&!state.lastEntity?' disabled':''}>${icons.left}</button><button class="icon-button" type="button" data-action="close-item" aria-label="Закрыть предмет">${icons.close}</button></div><div class="item-details">${image(item)}<div class="item-details-copy"><h2 title="${esc(item.id)}">${esc(item.name)}</h2><p class="detail-mod">${esc(mods.get(item.modId||'unknown')?.name||'')}</p></div><button class="icon-button${state.favorites.has(item.id)?' saved':''}" type="button" data-favorite="${esc(item.id)}" aria-label="${state.favorites.has(item.id)?'Убрать из избранного':'В избранное'}" aria-pressed="${state.favorites.has(item.id)}">${icons.star}</button></div><div class="recipe-tabs" role="tablist" aria-label="Рецепты и применение"><button type="button" class="recipe-tab${state.tab==='recipes'?' active':''}" data-tab="recipes" role="tab" aria-selected="${state.tab==='recipes'}">Крафт<span>${own.length}</span></button><button type="button" class="recipe-tab${state.tab==='usage'?' active':''}" data-tab="usage" role="tab" aria-selected="${state.tab==='usage'}">Применение<span>${used.length}</span></button></div><div class="recipe-body" role="tabpanel">${body}</div>`;
    $('inspector').classList.add('is-open');$('inspector').scrollTop=0;syncOverlay();
    if(focusedTab)$('inspector').querySelector(`[data-tab="${focusedTab}"]`)?.focus({preventScroll:true});
  }
  function focusable(){return [...$('inspector').querySelectorAll('button:not([disabled]),a[href],summary,[tabindex]:not([tabindex="-1"])')].filter(node=>!node.closest('[inert]')&&node.getClientRects().length);}
  function inaccessible(element,value){if(value&&element.contains(document.activeElement))document.activeElement.blur();element.inert=value;if(value)element.setAttribute('aria-hidden','true');else element.removeAttribute('aria-hidden');}
  function syncOverlay(){
    const mobile=window.matchMedia('(max-width: 991px)').matches,open=mobile&&!!(state.selected||state.entity)&&catalog.items.length>0;
    if(open&&!drawerOpen){returnFocus=document.activeElement;returnItem=document.activeElement?.closest('[data-item]')?.dataset.item||state.selected;}
    const wasOpen=drawerOpen;drawerOpen=open;$('inspector-scrim').hidden=!open;
    inaccessible($('inspector'),mobile&&!open);inaccessible($('catalog'),open);inaccessible($('toolbar'),open);inaccessible($('page-heading'),open);inaccessible(document.querySelector('.app-header'),open);
    if(open){$('inspector').setAttribute('role','dialog');$('inspector').setAttribute('aria-modal','true');if(!$('inspector').contains(document.activeElement))focusable()[0]?.focus({preventScroll:true});}
    else{$('inspector').removeAttribute('role');$('inspector').removeAttribute('aria-modal');if(wasOpen){let target=returnFocus;if(!target?.isConnected)target=[...$('items-grid').querySelectorAll('[data-select]')].find(node=>node.dataset.select===returnItem);if(!target?.isConnected||target.closest('[inert]')||!target.getClientRects().length)target=$('search-input');target.focus({preventScroll:true});returnFocus=null;returnItem=null;}}
    document.body.style.overflow=open?'hidden':'';
  }
  function action(name){if(name==='reset')reset();else if(name==='reload')location.reload();else if(name==='close-item')closeItem();else if(name==='back'){const id=state.trail.pop();if(id)select(id,'recipes',false);else if(state.lastEntity){const e=state.lastEntity;selectEntity(e.kind,e.id);}}}
  document.addEventListener('click',(event)=>{
    const button=event.target.closest('button');if(!button||button.disabled)return;
    if(button.dataset.page){state.page+=Number(button.dataset.page);renderCatalog();$('catalog-pagination').querySelector(`[data-page="${button.dataset.page}"]:not(:disabled)`)?.focus({preventScroll:true});return;}
    if(button.dataset.favorite)favorite(button.dataset.favorite);else if(button.dataset.select)select(button.dataset.select);else if(button.dataset.tab){state.tab=button.dataset.tab;state.recipeIndex=0;renderInspector();}else if(button.dataset.step){state.recipeIndex+=Number(button.dataset.step);renderInspector();}else if(button.dataset.action)action(button.dataset.action);
  });
  $('search-input').addEventListener('input',()=>{clearTimeout(searchTimer);searchTimer=setTimeout(()=>{state.query=$('search-input').value;state.limit=150;state.page=0;renderCatalog();},90);});
  $('clear-search').addEventListener('click',()=>{clearTimeout(searchTimer);state.query='';$('search-input').value='';state.limit=150;state.page=0;renderCatalog();$('search-input').focus();});
  $('mod-filter').addEventListener('change',()=>{state.mod=$('mod-filter').value;state.limit=150;state.page=0;renderCatalog();});
  $('favorite-items').addEventListener('click',()=>{if(state.view!=='catalog')setView('catalog');state.favoritesOnly=!state.favoritesOnly;state.limit=150;state.page=0;renderCatalog();});
  $('quests-nav').addEventListener('click',()=>setView('quests'));$('guides-nav').addEventListener('click',()=>setView('guides'));
  $('home-button').addEventListener('click',reset);$('catalog-nav').addEventListener('click',reset);
  $('inspector-scrim').addEventListener('click',closeItem);$('load-more').addEventListener('click',()=>{state.limit+=150;renderCatalog();});
  $('content').addEventListener('pointerover',(event)=>{hoverItem=event.target.closest('[data-select]')?.dataset.select||event.target.closest('[data-item]')?.dataset.item||null;});
  $('content').addEventListener('pointerleave',()=>{hoverItem=null;});$('content').addEventListener('focusin',(event)=>{hoverItem=event.target.closest('[data-select]')?.dataset.select||event.target.closest('[data-item]')?.dataset.item||null;});
  let resizeTimer;window.addEventListener('resize',()=>{syncOverlay();clearTimeout(resizeTimer);resizeTimer=setTimeout(renderCatalog,120);});window.addEventListener('popstate',()=>{const id=new URL(location.href).searchParams.get('item');if(id&&items.has(id))select(id,'recipes',false);else closeItem();});
  document.addEventListener('keydown',(event)=>{
    if(event.key==='Tab'&&drawerOpen){const all=focusable(),first=all[0],last=all[all.length-1];if(!first){event.preventDefault();return;}if(event.shiftKey&&(document.activeElement===first||!$('inspector').contains(document.activeElement))){event.preventDefault();last.focus();}else if(!event.shiftKey&&(document.activeElement===last||!$('inspector').contains(document.activeElement))){event.preventDefault();first.focus();}return;}
    const editing=event.target instanceof HTMLInputElement||event.target instanceof HTMLSelectElement||event.target instanceof HTMLTextAreaElement||event.target.isContentEditable;
    if(event.key==='Escape'){if(state.selected||state.entity){event.preventDefault();closeItem();}else if(editing)event.target.blur();return;}
    if(editing||event.ctrlKey||event.metaKey||event.altKey)return;
    if(event.key==='/'&&!drawerOpen){event.preventDefault();$('search-input').focus();}
    else if(['r','R','к','К'].includes(event.key)&&(hoverItem||state.selected)){event.preventDefault();select(hoverItem||state.selected,'recipes');}
    else if(['u','U','г','Г'].includes(event.key)&&(hoverItem||state.selected)){event.preventDefault();select(hoverItem||state.selected,'usage');}
  });
  async function init(){
    syncOverlay();
    let next,stage='network';
    try{
      const response=await fetch(dataUrl('catalog'),{cache:'no-cache'});
      if(!response.ok)throw new Error(`HTTP ${response.status}: ${response.url}`);
      stage='json';const raw=await response.json();
      stage='validation';next=validateCatalog(raw);
    }catch(error){console.error(`[UniLand] Ошибка загрузки каталога (${stage})`,error);next=emptyCatalog(true);}
    applyCatalog(next);
    const params=new URL(location.href).searchParams;const id=params.get('item');if(id&&items.has(id))select(id,'recipes',false);
    window.dispatchEvent(new Event('uniland-ready'));
    if(params.get('quest')||params.get('guide')||['quests','guides'].includes(params.get('view'))){const view=params.get('quest')?'quests':params.get('guide')?'guides':params.get('view');setView(view);await window.UniLandKnowledge?.ensure();if(params.get('quest'))selectEntity('quest',params.get('quest'));if(params.get('guide'))selectEntity('guide',params.get('guide'));}
  }
  window.UniLand={state,esc,image,icons,num,norm,dataUrl,select,selectEntity,setView,renderCatalog,renderInspector,configureFilter,capacity,pagination,get items(){return items;},get catalog(){return catalog;}};
  init();
})();
