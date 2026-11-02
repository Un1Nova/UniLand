'use strict';
(() => {
  const $ = (id) => document.getElementById(id);
  const svg = (body) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
  const icons = {
    cube:svg('<path d="m12 3 9 5v9l-9 5-9-5V8l9-5ZM3 8l9 5 9-5m-9 5v9M7.5 5.5l9 5"/>'),
    search:svg('<circle cx="10.5" cy="10.5" r="6.8"/><path d="m16 16 4.5 4.5"/>'),
    star:svg('<path d="m12 3 2.8 5.7 6.3.9-4.5 4.4 1.1 6.2-5.7-3-5.7 3 1.1-6.2L3.2 9.6l6-.9L12 3Z"/>'),
    close:svg('<path d="m6 6 12 12M6 18 18 6"/>'),
    info:svg('<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7h.01"/>'),
    down:svg('<path d="m6 9 6 6 6-6"/>'),
    left:svg('<path d="m15 5-7 7 7 7"/>'),
    right:svg('<path d="m9 5 7 7-7 7"/>'),
    arrow:svg('<path d="M3 12h17m-6-6 6 6-6 6"/>'),
    external:svg('<path d="M14 3h7v7m0-7L10 14M10 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-5"/>')
  };
  const esc = (value) => String(value ?? '').replace(/[&<>"']/g,(c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const num = (value) => new Intl.NumberFormat('ru-RU').format(value);
  const norm = (value) => String(value ?? '').toLocaleLowerCase('ru').replace(/ё/g,'е').normalize('NFKD').replace(/[\u0300-\u036f]/g,'').trim();
  const plural = (n,a,b,c) => { const m=Math.abs(n)%100,d=m%10; return m>=11&&m<=14?c:d===1?a:d>=2&&d<=4?b:c; };
  const itemsLabel = (n) => `${num(n)} ${plural(n,'предмет','предмета','предметов')}`;
  const recipesLabel = (n) => `${num(n)} ${plural(n,'рецепт','рецепта','рецептов')}`;
  const positive = (value) => typeof value==='number'&&Number.isFinite(value)&&value>0?value:1;
  const amount = (stack) => `${num(positive(stack.count))}${stack.unit?' '+stack.unit:''}`;
  const chance = (value) => typeof value==='number'&&Number.isFinite(value)&&value>=0&&value<=1?`${num(value*100)}%`:'';
  const knownGrid = (recipe) => ['shaped','crafting'].includes(recipe.type)&&Number.isInteger(recipe.width)&&Number.isInteger(recipe.height)&&recipe.inputs.every(stack=>Number.isInteger(stack.slot));
  const strings = (value) => Array.isArray(value)?value.filter((v)=>typeof v==='string'):[];
  const safeUrl = (value,image=false) => {
    if(typeof value!=='string'||value.length>(image?1200000:6000))return '';
    if(image&&/^data:image\/(png|jpeg|webp|gif);base64,[a-z0-9+/=\s]+$/i.test(value))return value;
    try{return ['https:','http:'].includes(new URL(value,location.href).protocol)?value:'';}catch{return '';}
  };
  const readLocal = (key,fallback) => {try{return JSON.parse(localStorage.getItem(key))??fallback;}catch{return fallback;}};
  const writeLocal = (key,value) => {try{localStorage.setItem(key,JSON.stringify(value));}catch{}};
  const emptyCatalog = (loadFailed=false) => ({schemaVersion:1,meta:{status:'unavailable',loadFailed},mods:[],items:[],recipes:[]});
  let catalog=emptyCatalog(),items=new Map(),mods=new Map(),searchIndex=new Map(),byOutput=new Map(),byInput=new Map();
  let hoverItem=null,searchTimer,drawerOpen=false,returnFocus=null,returnItem=null;
  const favorites=readLocal('atlas.favorites',[]);
  const state={query:'',mod:'',favoritesOnly:false,recipesOnly:false,selected:null,tab:'recipes',recipeIndex:0,limit:150,trail:[],favorites:new Set(Array.isArray(favorites)?favorites.filter(v=>typeof v==='string'):[])};
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
      if (!Array.isArray(recipe.inputs) || !Array.isArray(recipe.outputs) || !recipe.outputs.length) throw new Error(`У рецепта ${recipe.id.slice(0,60)} нужны inputs и непустой outputs.`);
      if (recipe.inputs.length > 512 || recipe.outputs.length > 128) throw new Error('Слишком много ингредиентов в одном рецепте.');
      for (const dimension of ['width','height']) {
        if (recipe[dimension] !== undefined && (!Number.isInteger(recipe[dimension]) || recipe[dimension] < 1 || recipe[dimension] > 9)) throw new Error('Размер сетки рецепта должен быть от 1 до 9 ячеек по каждой стороне.');
      }
      const explicitGrid = Number.isInteger(recipe.width) && Number.isInteger(recipe.height);
      const capacity = explicitGrid ? recipe.width * recipe.height : null;
      const occupied = new Set();
      for (const stack of recipe.inputs) {
        if (stack?.slot === undefined) continue;
        if (!Number.isSafeInteger(stack.slot) || stack.slot < 0 || (explicitGrid && stack.slot >= capacity)) throw new Error(`Ячейка рецепта ${recipe.id.slice(0,60)} выходит за границы сетки.`);
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
  function dataStatus(){
    const meta=catalog.meta||{},coverage=meta.coverage||{};
    const handlersComplete=Array.isArray(coverage.handlers)&&coverage.handlers.length>0&&coverage.handlers.every(handler=>handler&&handler.status==='exported'&&Number.isSafeInteger(handler.sourceCount)&&handler.sourceCount>=0&&handler.sourceCount===handler.exportedCount);
    const totalsMatch=(coverage.items===undefined||coverage.items===catalog.items.length)&&(coverage.recipes===undefined||coverage.recipes===catalog.recipes.length);
    const runtimeInventory=catalog.items.length>0&&catalog.recipes.length>0&&catalog.items.every(item=>!!item.icon)&&catalog.recipes.every(recipe=>recipe.verification==='runtime');
    const timestampHasZone=typeof meta.exportedAt==='string'&&/T.+(?:Z|[+-]\d{2}:\d{2})$/i.test(meta.exportedAt);
    const complete=meta.status==='complete'&&coverage.complete===true&&coverage.runtimeExport===true&&coverage.registryEnumerated===true&&meta.serverSynchronized===true&&typeof meta.clientManifestSha256==='string'&&/^[a-f0-9]{64}$/i.test(meta.clientManifestSha256)&&handlersComplete&&totalsMatch&&runtimeInventory&&timestampHasZone;
    const date=typeof meta.exportedAt==='string'?new Date(meta.exportedAt):null;
    const validDate=timestampHasZone&&date&&!Number.isNaN(date.getTime())&&date.getTime()<=Date.now()+300000;
    const old=validDate&&Date.now()-date.getTime()>14*86400000;
    const short=validDate?date.toLocaleDateString('ru-RU',{day:'2-digit',month:'2-digit',timeZone:'Europe/Moscow'}):'';
    const full=validDate?date.toLocaleString('ru-RU',{timeZone:'Europe/Moscow',dateStyle:'short',timeStyle:'short'}):'';
    if(meta.loadFailed)return {label:'База недоступна',detail:'Не удалось получить данные. Попробуй открыть страницу позже.',complete:false};
    if(!catalog.items.length)return {label:'Нет базы',detail:'Рецепты текущей сборки пока не опубликованы.',complete:false};
    if(!validDate)return {label:'Нет даты выгрузки',detail:'Время выгрузки клиента не подтверждено.',complete:false};
    if(old)return {label:'Обновить базу',detail:`Снимок ${full}. Выгрузке больше 14 дней.`,complete:false};
    return {label:complete?`Снимок ${short}`:'Частичная база',detail:`Снимок ${full}${complete?' · полная выгрузка клиента.':' · полнота не подтверждена.'}`,complete};
  }
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
    $('content').classList.toggle('empty-catalog',!catalog.items.length);renderCatalog();renderInspector();renderStatus();
  }
  function renderStatus(){const status=dataStatus();$('status-text').textContent=status.label;$('data-state').title=status.detail;$('data-state').classList.toggle('complete',status.complete);}
  function results(){const tokens=norm(state.query).split(/\s+/).filter(Boolean);return catalog.items.filter(item=>{
    if(state.mod&&(item.modId||'unknown')!==state.mod)return false;
    if(state.favoritesOnly&&!state.favorites.has(item.id))return false;
    if(state.recipesOnly&&!byOutput.has(item.id))return false;
    const entry=searchIndex.get(item.id);return tokens.every(token=>token.startsWith('@')?entry.mod.includes(token.slice(1)):entry.text.includes(token));
  });}
  function renderCatalog(){
    const filtered=results();$('result-count').textContent=catalog.items.length?itemsLabel(filtered.length):'';
    $('page-title').textContent=state.favoritesOnly?'Избранное':'Каталог крафтов';$('catalog-nav').classList.toggle('active',!state.favoritesOnly);$('catalog-nav').setAttribute('aria-pressed',String(!state.favoritesOnly));
    $('favorite-items').classList.toggle('active',state.favoritesOnly);$('favorite-items').setAttribute('aria-pressed',String(state.favoritesOnly));$('favorite-items').title=state.favoritesOnly?'Показать все предметы':'Избранное';
    $('recipe-filter').classList.toggle('active',state.recipesOnly);$('recipe-filter').setAttribute('aria-pressed',String(state.recipesOnly));
    $('clear-search').hidden=!state.query;$('search-shortcut').hidden=!!state.query;
    $('items-grid').innerHTML=filtered.slice(0,state.limit).map(item=>`<article class="item-card${state.selected===item.id?' selected':''}" data-item="${esc(item.id)}"><button class="card-star${state.favorites.has(item.id)?' saved':''}" type="button" data-favorite="${esc(item.id)}" aria-label="${state.favorites.has(item.id)?'Убрать из избранного':'В избранное'}: ${esc(item.name)}" aria-pressed="${state.favorites.has(item.id)}">${icons.star}</button><button class="item-select" type="button" data-select="${esc(item.id)}" title="${esc(item.name)}\n${esc(item.id)}" aria-label="${esc(item.name)}">${image(item)}<span class="item-name">${esc(item.name)}</span></button></article>`).join('');
    $('load-more').hidden=filtered.length<=state.limit;$('empty-state').hidden=!!filtered.length;
    if(!filtered.length){
      let title='Ничего не найдено',text='Измени поиск или фильтр.',action='reset',button='Сбросить';
      if(!catalog.items.length){title=catalog.meta.loadFailed?'База недоступна':'Нет актуальной базы';text=catalog.meta.loadFailed?'Не удалось получить данные. Попробуй позже.':'Рецепты текущей сборки пока не опубликованы.';action='';button='';}
      else if(state.favoritesOnly&&!state.query&&!state.mod&&!state.recipesOnly){title='Пока пусто';text='Сохраняй предметы звёздочкой.';button='Все предметы';}
      else if(state.recipesOnly&&!catalog.recipes.length){title='Крафты не загружены';text='В базе пока есть только предметы.';button='Все предметы';}
      $('empty-state').innerHTML=`<span>${icons.cube}</span><h2>${title}</h2><p>${text}</p>${action?`<button class="text-button" type="button" data-action="${action}">${button}</button>`:''}`;
    }
  }
  function reset(){state.query='';state.mod='';state.favoritesOnly=false;state.recipesOnly=false;state.limit=150;$('search-input').value='';$('mod-filter').value='';renderCatalog();}
  function favorite(id){
    if(!items.has(id))return;
    state.favorites.has(id)?state.favorites.delete(id):state.favorites.add(id);writeLocal('atlas.favorites',[...state.favorites]);
    const focused=document.activeElement?.dataset.favorite;const scroll=$('inspector').scrollTop;renderCatalog();if(state.selected===id){renderInspector();$('inspector').scrollTop=scroll;}
    if(focused){const target=[...document.querySelectorAll('[data-favorite]')].find(node=>node.dataset.favorite===focused&&!node.closest('[inert]'));target?.focus({preventScroll:true});}
  }
  function select(id,tab='recipes',remember=true){
    if(!items.has(id))return;
    if(remember&&state.selected&&state.selected!==id)state.trail.push(state.selected);
    state.trail=state.trail.slice(-30);state.selected=id;state.tab=tab;state.recipeIndex=0;renderInspector();
    document.querySelectorAll('[data-item]').forEach(node=>node.classList.toggle('selected',node.dataset.item===id));
    const url=new URL(location.href);url.searchParams.set('item',id);history.replaceState(null,'',url);
  }
  function closeItem(){state.selected=null;state.trail=[];renderInspector();document.querySelectorAll('.item-card.selected').forEach(node=>node.classList.remove('selected'));const url=new URL(location.href);url.searchParams.delete('item');history.replaceState(null,'',url);}
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
    const item=items.get(state.selected),focusedTab=$('inspector').contains(document.activeElement)?document.activeElement?.dataset.tab:null;
    if(!item){$('inspector').innerHTML='<div class="inspector-idle">Выбери предмет</div>';$('inspector').classList.remove('is-open');syncOverlay();return;}
    const own=byOutput.get(item.id)||[],used=byInput.get(item.id)||[],list=state.tab==='recipes'?own:used;
    state.recipeIndex=Math.max(0,Math.min(state.recipeIndex,list.length-1));const recipe=list[state.recipeIndex];
    const body=recipe?`<div class="recipe-heading"><h3>${esc(recipe.machine||(recipe.type==='shapeless'?'Верстак':typeNames[recipe.type])||recipe.title||recipe.type||'Рецепт')}</h3>${list.length>1?`<div class="recipe-pager"><button class="icon-button" type="button" data-step="-1" aria-label="Предыдущий рецепт"${!state.recipeIndex?' disabled':''}>${icons.left}</button><span>${state.recipeIndex+1}/${list.length}</span><button class="icon-button" type="button" data-step="1" aria-label="Следующий рецепт"${state.recipeIndex>=list.length-1?' disabled':''}>${icons.right}</button></div>`:''}</div>${recipeView(recipe)}`:`<p class="no-recipes">${state.tab==='recipes'?'Рецепт не загружен':'Применение не загружено'}</p>`;
    $('inspector').innerHTML=`<div class="inspector-nav"><button class="icon-button" type="button" data-action="back" aria-label="Предыдущий предмет"${!state.trail.length?' disabled':''}>${icons.left}</button><button class="icon-button" type="button" data-action="close-item" aria-label="Закрыть предмет">${icons.close}</button></div><div class="item-details">${image(item)}<div class="item-details-copy"><h2 title="${esc(item.id)}">${esc(item.name)}</h2><p class="detail-mod">${esc(mods.get(item.modId||'unknown')?.name||'')}</p></div><button class="icon-button${state.favorites.has(item.id)?' saved':''}" type="button" data-favorite="${esc(item.id)}" aria-label="${state.favorites.has(item.id)?'Убрать из избранного':'В избранное'}" aria-pressed="${state.favorites.has(item.id)}">${icons.star}</button></div><div class="recipe-tabs" role="tablist" aria-label="Рецепты и применение"><button type="button" class="recipe-tab${state.tab==='recipes'?' active':''}" data-tab="recipes" role="tab" aria-selected="${state.tab==='recipes'}">Крафт<span>${own.length}</span></button><button type="button" class="recipe-tab${state.tab==='usage'?' active':''}" data-tab="usage" role="tab" aria-selected="${state.tab==='usage'}">Применение<span>${used.length}</span></button></div><div class="recipe-body" role="tabpanel">${body}</div>`;
    $('inspector').classList.add('is-open');$('inspector').scrollTop=0;syncOverlay();
    if(focusedTab)$('inspector').querySelector(`[data-tab="${focusedTab}"]`)?.focus({preventScroll:true});
  }
  function focusable(){return [...$('inspector').querySelectorAll('button:not([disabled]),a[href],summary,[tabindex]:not([tabindex="-1"])')].filter(node=>!node.closest('[inert]')&&node.getClientRects().length);}
  function inaccessible(element,value){if(value&&element.contains(document.activeElement))document.activeElement.blur();element.inert=value;if(value)element.setAttribute('aria-hidden','true');else element.removeAttribute('aria-hidden');}
  function syncOverlay(){
    const mobile=window.matchMedia('(max-width: 991px)').matches,open=mobile&&!!state.selected&&catalog.items.length>0;
    if(open&&!drawerOpen){returnFocus=document.activeElement;returnItem=document.activeElement?.closest('[data-item]')?.dataset.item||state.selected;}
    const wasOpen=drawerOpen;drawerOpen=open;$('inspector-scrim').hidden=!open;
    inaccessible($('inspector'),mobile&&!open);inaccessible($('catalog'),open);inaccessible($('toolbar'),open);inaccessible($('page-heading'),open);inaccessible($('site-footer'),open);inaccessible(document.querySelector('.app-header'),open);
    if(open){$('inspector').setAttribute('role','dialog');$('inspector').setAttribute('aria-modal','true');if(!$('inspector').contains(document.activeElement))focusable()[0]?.focus({preventScroll:true});}
    else{$('inspector').removeAttribute('role');$('inspector').removeAttribute('aria-modal');if(wasOpen){let target=returnFocus;if(!target?.isConnected)target=[...$('items-grid').querySelectorAll('[data-select]')].find(node=>node.dataset.select===returnItem);if(!target?.isConnected||target.closest('[inert]')||!target.getClientRects().length)target=$('search-input');target.focus({preventScroll:true});returnFocus=null;returnItem=null;}}
    document.body.style.overflow=open?'hidden':'';
  }
  function settings(){
    const status=dataStatus(),sources=Array.isArray(catalog.meta.sources)?catalog.meta.sources.filter(source=>source&&safeUrl(source.url)):[];
    $('settings-content').innerHTML=`<p class="settings-counts">${itemsLabel(catalog.items.length)} · ${recipesLabel(catalog.recipes.length)}</p><p class="settings-status">${esc(status.detail)}</p>${sources.length?`<details class="settings-section"><summary>Источники</summary>${sources.map(source=>`<a href="${esc(source.url)}" target="_blank" rel="noopener noreferrer">${esc(source.title||source.url)} ↗</a>`).join('')}</details>`:''}`;
    if(!$('settings-dialog').open)$('settings-dialog').showModal();
  }
  function action(name){if(name==='reset')reset();else if(name==='close-item')closeItem();else if(name==='back'){const id=state.trail.pop();if(id)select(id,'recipes',false);}}
  document.addEventListener('click',(event)=>{
    const button=event.target.closest('button');if(!button||button.disabled)return;
    if(button.dataset.favorite)favorite(button.dataset.favorite);else if(button.dataset.select)select(button.dataset.select);else if(button.dataset.tab){state.tab=button.dataset.tab;state.recipeIndex=0;renderInspector();}else if(button.dataset.step){state.recipeIndex+=Number(button.dataset.step);renderInspector();}else if(button.dataset.action)action(button.dataset.action);
  });
  $('search-input').addEventListener('input',()=>{clearTimeout(searchTimer);searchTimer=setTimeout(()=>{state.query=$('search-input').value;state.limit=150;renderCatalog();},90);});
  $('clear-search').addEventListener('click',()=>{clearTimeout(searchTimer);state.query='';$('search-input').value='';state.limit=150;renderCatalog();$('search-input').focus();});
  $('mod-filter').addEventListener('change',()=>{state.mod=$('mod-filter').value;state.limit=150;renderCatalog();});
  $('recipe-filter').addEventListener('click',()=>{state.recipesOnly=!state.recipesOnly;state.limit=150;renderCatalog();});
  $('favorite-items').addEventListener('click',()=>{state.favoritesOnly=!state.favoritesOnly;state.limit=150;renderCatalog();});
  $('home-button').addEventListener('click',reset);$('catalog-nav').addEventListener('click',reset);$('settings-button').addEventListener('click',settings);$('data-state').addEventListener('click',settings);
  $('close-settings').addEventListener('click',()=>$('settings-dialog').close());$('inspector-scrim').addEventListener('click',closeItem);$('load-more').addEventListener('click',()=>{state.limit+=150;renderCatalog();});
  $('settings-dialog').addEventListener('click',(event)=>{if(event.target!==$('settings-dialog'))return;const rect=$('settings-dialog').getBoundingClientRect();if(event.clientX<rect.left||event.clientX>rect.right||event.clientY<rect.top||event.clientY>rect.bottom)$('settings-dialog').close();});
  $('content').addEventListener('pointerover',(event)=>{hoverItem=event.target.closest('[data-select]')?.dataset.select||event.target.closest('[data-item]')?.dataset.item||null;});
  $('content').addEventListener('pointerleave',()=>{hoverItem=null;});$('content').addEventListener('focusin',(event)=>{hoverItem=event.target.closest('[data-select]')?.dataset.select||event.target.closest('[data-item]')?.dataset.item||null;});
  window.addEventListener('resize',syncOverlay);window.addEventListener('popstate',()=>{const id=new URL(location.href).searchParams.get('item');if(id&&items.has(id))select(id,'recipes',false);else closeItem();});
  document.addEventListener('keydown',(event)=>{
    if($('settings-dialog').open)return;
    if(event.key==='Tab'&&drawerOpen){const all=focusable(),first=all[0],last=all[all.length-1];if(!first){event.preventDefault();return;}if(event.shiftKey&&(document.activeElement===first||!$('inspector').contains(document.activeElement))){event.preventDefault();last.focus();}else if(!event.shiftKey&&(document.activeElement===last||!$('inspector').contains(document.activeElement))){event.preventDefault();first.focus();}return;}
    const editing=event.target instanceof HTMLInputElement||event.target instanceof HTMLSelectElement||event.target instanceof HTMLTextAreaElement||event.target.isContentEditable;
    if(event.key==='Escape'){if(state.selected){event.preventDefault();closeItem();}else if(editing)event.target.blur();return;}
    if(editing||event.ctrlKey||event.metaKey||event.altKey)return;
    if(event.key==='/'&&!drawerOpen){event.preventDefault();$('search-input').focus();}
    else if(['r','R','к','К'].includes(event.key)&&(hoverItem||state.selected)){event.preventDefault();select(hoverItem||state.selected,'recipes');}
    else if(['u','U','г','Г'].includes(event.key)&&(hoverItem||state.selected)){event.preventDefault();select(hoverItem||state.selected,'usage');}
  });
  async function init(){
    syncOverlay();
    let next;
    try{
      const response=await fetch('catalog.json',{cache:'no-cache'});
      if(!response.ok)throw new Error('База недоступна');
      next=validateCatalog(await response.json());
    }catch{next=emptyCatalog(true);}
    applyCatalog(next);
    const id=new URL(location.href).searchParams.get('item');if(id&&items.has(id))select(id,'recipes',false);
  }
  init();
})();
