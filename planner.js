'use strict';
(() => {
  const app=window.UniLand,$=id=>document.getElementById(id),esc=app.esc,num=app.num;
  const saved=app.readLocal('uniland.production.v1',null);
  const plain=value=>value&&typeof value==='object'&&!Array.isArray(value)?value:{};
  const settings={target:typeof saved?.target==='string'?saved.target:null,count:Math.max(1,Math.min(1000000,Number(saved?.count)||1)),mode:saved?.mode==='all'?'all':'raw',recipeChoices:plain(saved?.recipeChoices),inputChoices:plain(saved?.inputChoices),outputChoices:plain(saved?.outputChoices),baseItems:Array.isArray(saved?.baseItems)?saved.baseItems.filter(x=>typeof x==='string'):[],expandedItems:Array.isArray(saved?.expandedItems)?saved.expandedItems.filter(x=>typeof x==='string'):[]};
  let mounted=false,plan=null,busy=false,error='',tab='tree',selected='root',viewport=null,canvasTransform=null,canvasSize=null,lastWorld=null,worker=null,workerReady=null,workerDisabled=false,fallback=null,serial=0,generation=0,nodeBudget=1200,timer=0,fitNext=true,openDetail=false;
  const pending=new Map(),expanded=new Set(['root']);
  const reasons={ 'no-recipe':'Рецепта нет в выгрузке','user-base':'Считается сырьём',cycle:'Циклическая цепочка','max-depth':'Достигнута глубина расчёта','max-nodes':'Достигнут объём расчёта','uncertain-output':'Выход требует уточнения', 'missing-item':'Нет данных о предмете','missing-recipe':'Рецепт недоступен','invalid-choice':'Вариант недоступен','reference-only':'Справочная запись','invalid-quantity':'Некорректное количество','unknown-input':'Не указаны исходные ресурсы','details-required':'Нужны условия рецепта','output-variants':'Результат зависит от условий','probabilistic-output':'Случайный выход','quantity-overflow':'Слишком большое количество','invalid-input-choice':'Ингредиент больше не подходит','invalid-output-choice':'Результат больше не подходит','recipe-does-not-produce':'Рецепт не производит этот ресурс','unknown-output':'Не указан результат','zero-chance':'Нулевая вероятность','invalid-stack':'Некорректный ингредиент' };
  const item=id=>app.items.get(id)||{id,name:id};
  const isMobile=()=>matchMedia('(max-width:760px)').matches;
  const amount=(count,unit)=>`${num(count)}${unit?' '+unit:''}`;
  const countLabel=row=>amount(row.count,row.unit);
  const reasonLabel=value=>reasons[value]||String(value||'Требует проверки');
  const statusLabel=node=>node.status==='craft'?app.machineName(node.recipeOptions?.find(r=>r.id===node.recipeId)||node):node.status==='reuse'?'Из остатка':node.status==='base'?'Сырьё':'Уточнить';
  const stackNote=row=>!row.unit&&Number.isInteger(row.count)&&row.count>=64?`${Math.floor(row.count/64)} × 64${row.count%64?' + '+row.count%64:''}`:'';
  const currentNode=()=>plan?.nodes.find(n=>n.id===selected)||plan?.root;
  const totalOps=()=>plan?.steps.reduce((sum,step)=>sum+step.batches,0)||0;
  const primitive=entry=>{
    if(entry.kind==='fluid'||entry.kind==='gas')return false;
    const english=(entry.englishName||'').replace(/§./g,'').trim(),russian=(entry.name||'').replace(/§./g,'').trim();
    return /(?:^|\s)(?:ingot|nugget|ore|log|gem)$/i.test(english)||/^(?:diamond|emerald|coal|charcoal|redstone|redstone dust|sand|red sand|gravel|cobblestone|obsidian|netherrack|quartz|nether quartz|clay|clay ball|dirt|lapis lazuli)$/i.test(english)||/(?:^|\s)(?:слиток|самородок|руда|бревно|самоцвет)$/i.test(russian)||/^(?:слиток|самородок|руда|бревно)\s/i.test(russian)||/^(?:алмаз|изумруд|уголь|древесный уголь|краснокаменная пыль|красная пыль|песок|гравий|булыжник|обсидиан|адский камень|лазурит|глина|земля)$/i.test(russian);
  };
  let primitiveIds=null;
  function bases(){
    if(!primitiveIds)primitiveIds=app.catalog.items.filter(primitive).map(entry=>entry.id);
    const result=new Set(settings.mode==='raw'?primitiveIds:[]);
    for(const id of settings.baseItems)result.add(id);
    for(const id of settings.expandedItems)result.delete(id);
    result.delete(settings.target);return [...result];
  }
  function persist(){app.writeLocal('uniland.production.v1',settings);}
  function syncUrl(){if(app.state.view!=='planner')return;const url=new URL(location.href);for(const key of ['item','quest','guide'])url.searchParams.delete(key);url.searchParams.set('view','planner');if(settings.target){url.searchParams.set('plan',settings.target);url.searchParams.set('qty',String(settings.count));}else{url.searchParams.delete('plan');url.searchParams.delete('qty');}history.replaceState(null,'',url);}
  function rejectWorker(reason){for(const request of pending.values()){clearTimeout(request.timeout);request.reject(reason);}pending.clear();worker?.terminate();worker=null;workerReady=null;workerDisabled=true;}
  function message(type,payload){return new Promise((resolve,reject)=>{const requestId=++serial;const timeout=setTimeout(()=>{pending.delete(requestId);reject(new Error('Расчёт занимает слишком много времени. Попробуй уменьшить цепочку.'));},30000);pending.set(requestId,{resolve,reject,timeout});worker.postMessage({type,requestId,...payload});});}
  async function getWorker(){
    if(workerDisabled||!window.Worker)return null;
    if(workerReady)return workerReady;
    workerReady=(async()=>{
      try{
        worker=new Worker(new URL(app.dataUrl('planner-worker'),document.baseURI));
        worker.addEventListener('message',event=>{const data=event.data||{},request=pending.get(data.requestId);if(!request)return;pending.delete(data.requestId);clearTimeout(request.timeout);if(data.type==='error')request.reject(new Error(data.error));else request.resolve(data.result||true);});
        worker.addEventListener('error',event=>rejectWorker(new Error(event.message||'Расчётный модуль недоступен.')));
        await message('init',{catalogUrl:new URL(app.dataUrl('runtime')||app.dataUrl('catalog'),document.baseURI).href,decoderUrl:document.querySelector('script[data-runtime]').src,engineUrl:document.querySelector('script[data-planner-engine]').src});
        return worker;
      }catch(reason){console.warn('[UniLand] Worker недоступен, используется ограниченный локальный расчёт',reason);rejectWorker(reason);return null;}
    })();return workerReady;
  }
  async function compute(){
    const mine=++generation;
    if(!app.ready||!settings.target||!app.items.has(settings.target)){busy=false;render();return;}
    busy=true;error='';if(plan){renderTarget();renderStatus();}else render();
    try{
      const options={target:{itemId:settings.target,count:settings.count},recipeChoices:settings.recipeChoices,inputChoices:settings.inputChoices,outputChoices:settings.outputChoices,baseItems:bases(),maxDepth:nodeBudget>1200?64:48,maxNodes:nodeBudget};
      const activeWorker=await getWorker();if(mine!==generation)return;
      let result;
      if(activeWorker)result=await message('plan',{options});
      else{await new Promise(resolve=>setTimeout(resolve,0));fallback ||= window.UniLandPlanner.createPlanner(app.catalog);result=fallback.plan({...options,maxNodes:450});}
      if(mine!==generation)return;
      plan=result;busy=false;if(!plan.nodes.some(node=>node.id===selected))selected='root';render();
    }catch(reason){if(mine!==generation)return;busy=false;error=reason.message||'Не удалось рассчитать цепочку.';console.error('[UniLand] Ошибка расчёта',reason);render();}
  }
  function schedule(resetViewport=false){generation++;persist();syncUrl();fitNext ||= resetViewport;clearTimeout(timer);busy=true;error='';if(!plan)render();else renderStatus();timer=setTimeout(compute,100);}
  function mount(){
    if(mounted)return;mounted=true;
    $('planner-view').innerHTML=`<div class="production-shell"><div class="production-topline"><div class="production-target" id="production-target"></div><div class="production-quantity"><label for="production-quantity">Количество</label><div><button type="button" data-production="less" aria-label="Уменьшить количество">−</button><input id="production-quantity" type="number" inputmode="numeric" min="1" max="1000000" step="1" value="${settings.count}" aria-label="Количество предметов для производства"><button type="button" data-production="more" aria-label="Увеличить количество">+</button></div></div></div><div class="production-toolbar"><div class="production-tabs" role="tablist" aria-label="Представление плана"><button id="production-tab-tree" role="tab" aria-controls="production-canvas" type="button" data-production-tab="tree" aria-selected="true">Схема</button><button id="production-tab-materials" role="tab" aria-controls="production-materials" type="button" data-production-tab="materials" aria-selected="false">Сырьё<span id="production-material-count"></span></button><button id="production-tab-steps" role="tab" aria-controls="production-steps" type="button" data-production-tab="steps" aria-selected="false">Шаги</button></div><div class="production-options"><label><span class="sr-only">Глубина разбора</span><select id="production-depth"><option value="raw">До сырья</option><option value="all">Все стадии</option></select></label><button class="icon-button" type="button" data-production="reset" aria-label="Сбросить выбранные рецепты и сырьё" title="Сбросить варианты">↺</button></div></div><div class="production-body" id="production-body"><div class="production-main"><div id="production-canvas" class="production-canvas" role="tabpanel" aria-labelledby="production-tab-tree" tabindex="0" aria-label="Дерево производства. Перетаскивай для перемещения, используй два пальца или колесо для масштаба."><div id="production-world" class="production-world"></div><div class="production-map-controls" data-viewport-ignore><button type="button" data-production="zoom-out" aria-label="Уменьшить схему">−</button><button type="button" data-production="fit" aria-label="Показать всю схему">Вся схема</button><button type="button" data-production="zoom-in" aria-label="Увеличить схему">+</button></div></div><section id="production-materials" class="production-list-view" role="tabpanel" aria-labelledby="production-tab-materials" hidden></section><section id="production-steps" class="production-list-view" role="tabpanel" aria-labelledby="production-tab-steps" hidden></section><div id="production-empty" class="production-empty" hidden></div></div><dialog id="production-inspector" class="production-inspector" aria-label="Шаг производства"></dialog></div><footer class="production-status" id="production-status" aria-live="polite"></footer></div>`;
    $('production-depth').value=settings.mode;
    $('production-quantity').addEventListener('input',event=>{const value=Number(event.target.value);if(Number.isSafeInteger(value)&&value>=1&&value<=1000000){settings.count=value;schedule();}});
    $('production-quantity').addEventListener('blur',()=>{$('production-quantity').value=settings.count;});
    $('production-depth').addEventListener('change',event=>{settings.mode=event.target.value;schedule(true);});
    $('production-inspector').addEventListener('close',()=>{if($('production-inspector').open)return;openDetail=false;$('production-body').classList.remove('has-detail');if(app.state.view==='planner'&&(document.activeElement===document.body||!document.activeElement?.isConnected||$('production-inspector').contains(document.activeElement)||!document.activeElement.getClientRects().length)){const panel=$(`production-${tab==='tree'?'world':tab}`),target=[...panel.querySelectorAll('[data-plan-node]')].find(element=>element.dataset.planNode===selected&&element.getClientRects().length);(target||$(`production-tab-${tab}`)).focus({preventScroll:true});}});
    $('production-inspector').addEventListener('keydown',event=>{if(event.key==='Escape'){event.preventDefault();event.stopPropagation();closeDetail();}});
    $('planner-view').addEventListener('click',onClick);
    $('planner-view').addEventListener('change',onChange);
    $('planner-view').addEventListener('keydown',event=>{if(event.target.closest('.production-tabs')&&['ArrowLeft','ArrowRight','Home','End'].includes(event.key)){event.preventDefault();const tabs=['tree','materials','steps'],index=tabs.indexOf(tab),next=event.key==='Home'?0:event.key==='End'?2:(index+(event.key==='ArrowRight'?1:2))%3;switchTab(tabs[next]);$(`production-tab-${tabs[next]}`).focus();}});
    window.addEventListener('resize',()=>{if(app.state.view==='planner'&&openDetail)showDetail(false);});
  }
  function renderTarget(){
    const target=app.items.get(settings.target);$('production-target').innerHTML=target?`${app.image(target)}<div><h1>${esc(target.name)}</h1><button type="button" data-production="choose">Сменить предмет</button></div>`:'<div><h1>План производства</h1><p>Выбери предмет в каталоге</p></div>';
    if(document.activeElement!==$('production-quantity'))$('production-quantity').value=settings.count;
    $('production-quantity').disabled=!target;$('production-depth').value=settings.mode;
  }
  function switchTab(value){tab=value;closeDetail();renderTabs();if(value==='tree')renderGraph();else if(value==='materials')renderMaterials();else renderSteps();}
  function renderTabs(){for(const name of ['tree','materials','steps']){const active=tab===name;const control=$(`production-tab-${name}`);control.setAttribute('aria-selected',String(active));control.tabIndex=active?0:-1;$(`production-${name==='tree'?'canvas':name}`).hidden=!active||!plan;} $('production-material-count').textContent=plan?.baseMaterials.length?String(plan.baseMaterials.length):'';}
  function renderStatus(){
    if(!mounted)return;
    const host=$('production-status');host.classList.toggle('is-busy',busy);
    if(busy){host.innerHTML='<span class="loading-ring" aria-hidden="true"></span><span>Рассчитываю цепочку…</span>';return;}
    if(error){host.innerHTML=`<span>${esc(error)}</span><button type="button" data-production="${settings.target?'retry':'choose'}">${settings.target?'Повторить':'К каталогу'}</button>`;return;}
    if(!plan){host.textContent='';return;}
    const pendingCount=plan.unresolvedMaterials?.length||0,limited=plan.issues.some(issue=>['max-depth','max-nodes'].includes(issue.code));
    host.innerHTML=`<span>${num(plan.steps.length)} этапов · ${num(totalOps())} операций</span>${limited&&nodeBudget<9600?'<button type="button" data-production="deeper">Продолжить расчёт</button>':''}${pendingCount?`<button type="button" data-production="unresolved">Уточнить: ${num(pendingCount)}</button>`:plan.approximate?'<span>Ожидаемый расход, без гарантии выхода</span>':'<span class="production-source-note">По данным текущей выгрузки</span>'}`;
  }
  function render(){
    mount();if(app.state.view!=='planner')return;
    renderTarget();renderTabs();renderStatus();
    const empty=$('production-empty');empty.hidden=!!plan&&!error;
    if(!empty.hidden){empty.innerHTML=error?`<h2>${settings.target?'Не удалось рассчитать':'Предмет не найден'}</h2><p>${esc(error)}</p><button type="button" data-production="${settings.target?'retry':'choose'}">${settings.target?'Повторить':'К каталогу'}</button>`:!app.ready||busy?'<span class="loading-ring" aria-hidden="true"></span><h2>Подготавливаю расчёт…</h2>':`<span>${app.icons.map}</span><h2>От предмета — к сырью</h2><p>Открой предмет и нажми «Рассчитать производство».</p><button type="button" data-production="choose">Выбрать предмет</button>`;}
    if(plan){if(tab==='tree')renderGraph();else if(tab==='materials')renderMaterials();else renderSteps();if(openDetail)showDetail(false);}
  }
  function layoutTree(){
    const cardWidth=218,cardHeight=122,gap=28,level=174,positions=new Map(),visible=[];
    const children=node=>node.children?.length&&!collapsedRoot.has(node.id)&&(expanded.has(node.id)||node.id.split('/').length<2)?node.children:[];
    function measure(node){const list=children(node);const width=Math.max(cardWidth,list.reduce((sum,child)=>sum+measure(child),0)+Math.max(0,list.length-1)*gap);positions.set(node.id,{width,children:list});return width;}
    const width=measure(plan.root)+48;let depth=0;
    function place(node,left,d){const position=positions.get(node.id);position.x=left+(position.width-cardWidth)/2;position.y=24+d*level;visible.push(node);depth=Math.max(depth,d);let x=left;for(const child of position.children){place(child,x,d+1);x+=positions.get(child.id).width+gap;}}
    place(plan.root,24,0);return {width,height:48+depth*level+cardHeight,visible,positions,cardWidth,cardHeight};
  }
  function renderGraph(){
    if(!plan||tab!=='tree')return;
    const geometry=layoutTree(),world=$('production-world'),canvas=$('production-canvas');
    const focused=document.activeElement,focusToken=world.contains(focused)?{kind:focused.dataset.planExpand!==undefined?'planExpand':'planNode',value:focused.dataset.planExpand??focused.dataset.planNode}:null;
    if(viewport){canvasTransform=viewport.getTransform();canvasSize=viewport.getViewportSize();}viewport?.destroy();viewport=null;
    const paths=[];
    for(const node of geometry.visible){const parent=geometry.positions.get(node.parentId),point=geometry.positions.get(node.id);if(!parent)continue;const x=point.x+geometry.cardWidth/2,y=point.y,px=parent.x+geometry.cardWidth/2,py=parent.y+geometry.cardHeight,mid=(y+py)/2;paths.push(`<path d="M${x},${y} C${x},${mid} ${px},${mid} ${px},${py+6}" marker-end="url(#production-arrow)"/>`);}
    const cards=geometry.visible.map(node=>{const p=geometry.positions.get(node.id),entry=item(node.itemId),isExpanded=p.children.length>0,hasChildren=node.children?.length>0;return `<article class="production-node${selected===node.id?' selected':''}${node.status==='unresolved'?' unresolved':''}" style="left:${p.x}px;top:${p.y}px" data-node-container="${esc(node.id)}"><button class="production-node-main" type="button" data-plan-node="${esc(node.id)}" aria-label="${esc(entry.name)}, ${esc(countLabel(node))}, ${esc(statusLabel(node))}">${app.image(entry)}<span class="production-node-copy"><strong>${esc(entry.name)}</strong><span class="production-node-count">${esc(countLabel(node))}</span></span></button><div class="production-node-meta"><span>${esc(statusLabel(node))}</span>${node.status==='craft'?`<span>${num(node.batches)}×</span>`:node.status==='unresolved'?'<span>!</span>':''}</div>${hasChildren?`<button class="production-expand" type="button" data-plan-expand="${esc(node.id)}" aria-expanded="${isExpanded}">${isExpanded?'Свернуть':'Развернуть'} · ${node.children.length}</button>`:`<span class="production-leaf-note">${node.status==='reuse'?'Использован доступный остаток':node.status==='unresolved'?esc(reasonLabel(node.reason)):'Базовый материал'}</span>`}</article>`;}).join('');
    world.innerHTML=`<svg class="production-links" viewBox="0 0 ${geometry.width} ${geometry.height}" aria-hidden="true"><defs><marker id="production-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0 0L10 5L0 10Z" class="arrow-head"/></marker></defs>${paths.join('')}</svg>${cards}`;
    const rootPosition=geometry.positions.get(plan.root.id),scale=1;
    let initial=fitNext||!canvasTransform?{x:canvas.clientWidth/2-(rootPosition.x+geometry.cardWidth/2)*scale,y:24,scale}:{...canvasTransform};
    if(!fitNext&&canvasTransform&&canvasSize){initial.x+=(canvas.clientWidth-canvasSize.width)/2;initial.y+=(canvas.clientHeight-canvasSize.height)/2;}
    if(!fitNext&&lastWorld&&canvasTransform){const before=lastWorld.positions.get(selected),after=geometry.positions.get(selected);if(before&&after){initial.x+=(before.x-after.x)*initial.scale;initial.y+=(before.y-after.y)*initial.scale;}}
    viewport=window.UniLandViewport.create({viewport:canvas,world,width:geometry.width,height:geometry.height,minScale:.08,maxScale:2.2,fitMaxScale:1,padding:24,initialTransform:initial,fitOnResize:false,onChange:(value,size)=>{canvasTransform=value;canvasSize=size;}});
    lastWorld=geometry;fitNext=false;
    if(focusToken)[...world.querySelectorAll('[data-plan-node],[data-plan-expand]')].find(element=>element.dataset[focusToken.kind]===focusToken.value)?.focus({preventScroll:true});
  }
  function materialRow(row,unresolved=false){const entry=item(row.itemId),note=stackNote(row);return `<button type="button" class="production-material${unresolved?' is-unresolved':''}" ${row.nodeIds?.length?`data-plan-node="${esc(row.nodeIds[0])}"`:`data-plan-open-item="${esc(row.itemId)}"`}>${app.image(entry)}<span><strong>${esc(entry.name)}</strong><small>${unresolved?esc(reasonLabel(row.reason)):row.reason==='no-recipe'?'Без рецепта в выгрузке':note?esc(note):' '}</small></span><b>${esc(countLabel(row))}</b>${unresolved?'<i aria-label="Требует уточнения">!</i>':''}</button>`;}
  function renderMaterials(){
    if(!plan)return;const rows=[...plan.baseMaterials].sort((a,b)=>item(a.itemId).name.localeCompare(item(b.itemId).name,'ru')),unknown=plan.unresolvedMaterials||[],leftovers=plan.leftovers||[];
    $('production-materials').innerHTML=`<div class="production-list-heading"><div><h2>Список сырья</h2><p>Для ${esc(amount(settings.count,plan.target?.unit))} × ${esc(item(settings.target).name)}</p></div><button type="button" class="production-text-button" data-production="copy">Скопировать</button></div>${settings.mode==='raw'?'<p class="production-list-note">Разбор остановлен на слитках, рудах, самоцветах и древесине. Любой материал можно раскрыть дальше.</p>':''}<div class="production-material-grid">${rows.map(row=>materialRow(row)).join('')||'<p class="production-list-note">Базовое сырьё не требуется либо ещё не определено.</p>'}</div>${unknown.length?`<section class="production-unresolved" id="production-unresolved"><h3>Требует уточнения · ${unknown.length}</h3><p>Эти количества не включены в рассчитанный список сырья.</p><div class="production-material-grid">${unknown.map(row=>materialRow(row,true)).join('')}</div></section>`:''}${leftovers.length?`<details class="production-leftovers"><summary>Остатки после производства · ${leftovers.length}</summary><div class="production-material-grid">${leftovers.map(row=>materialRow(row)).join('')}</div></details>`:''}`;
  }
  function stackLine(stack){return `${item(stack.itemId).name} × ${amount(stack.count,stack.unit)}${stack.role==='catalyst'?' (инструмент)':''}`;}
  function stackSummary(stacks){const grouped=new Map();for(const stack of stacks){const key=JSON.stringify([stack.key||[stack.itemId,stack.unit||'',stack.nbt||null],stack.role||'consumed']);if(grouped.has(key))grouped.get(key).count+=stack.count;else grouped.set(key,{...stack});}return [...grouped.values()].map(stackLine).join(' + ');}
  function renderSteps(){
    if(!plan)return;$('production-steps').innerHTML=`<div class="production-list-heading"><div><h2>Порядок производства</h2><p>От первых операций к готовому предмету</p></div></div><ol class="production-steps">${plan.steps.map((step,index)=>`<li><button type="button" data-plan-node="${esc(step.id)}"><span class="production-step-index">${index+1}</span>${app.image(item(step.itemId))}<span class="production-step-copy"><strong>${esc(app.machineName(step))}</strong><span>${esc(item(step.itemId).name)} · ${num(step.batches)} операций</span><small>${esc(stackSummary(step.inputs||[]))}</small></span>${app.icons.right}</button></li>`).join('')}</ol>${!plan.steps.length?'<p class="production-list-note">В этой цепочке нет рассчитанных операций.</p>':''}`;
  }
  function closeDetail(){const dialog=$('production-inspector');if(dialog?.open)dialog.close();openDetail=false;$('production-body')?.classList.remove('has-detail');}
  function showDetail(focus=true){
    const node=currentNode();if(!node)return;selected=node.id;openDetail=true;
    const dialog=$('production-inspector'),entry=item(node.itemId),parent=plan.nodes.find(n=>n.id===node.parentId),selectedRecipe=node.recipeOptions?.find(recipe=>recipe.id===node.recipeId),recipeOptions=node.recipeOptions||[],base=bases().includes(node.itemId),isRoot=node.id==='root';
    const options=recipeOptions.map((recipe,index)=>{const source=app.recipeById(recipe.id),names=[...new Set((source?.inputs||[]).map(stack=>item(stack.itemId).name))],hint=names.slice(0,2).join(', ')+(names.length>2?'…':'');return `<option value="${esc(recipe.id)}"${recipe.id===node.recipeId?' selected':''}${recipe.reference?' disabled':''}>${index+1}. ${esc(app.machineName(recipe))}${hint?' · '+esc(hint):''} · ×${num(recipe.yield)}${recipe.uncertain?' · уточнить':''}${recipe.reference?' · справка':''}</option>`;}).join('');
    const choices=(node.inputOptions||[]).filter(input=>input.choices.length>1).map(input=>`<label class="production-field"><span>Ингредиент ${input.index+1}</span><select data-input-choice="${esc(input.key)}">${input.choices.map(choice=>`<option value="${choice.index}"${choice.index===input.selected?' selected':''}>${esc(item(choice.itemId).name)} × ${esc(amount(choice.count,choice.unit))}</option>`).join('')}</select></label>`).join('');
    const outputChoices=(node.outputOptions||[]).filter(output=>output.choices.length>1).map(output=>`<label class="production-field"><span>Вариант результата ${output.index+1}</span><select data-output-choice="${esc(output.key)}">${output.choices.map(choice=>`<option value="${choice.index}"${choice.index===output.selected?' selected':''}>${esc(item(choice.itemId).name)} × ${esc(amount(choice.count,choice.unit))}</option>`).join('')}</select></label>`).join('');
    const focusKeys=['recipeChoice','inputChoice','outputChoice','production','planNode'],active=document.activeElement,focusKey=dialog.contains(active)?focusKeys.find(key=>active.dataset?.[key]!==undefined):null,focusValue=focusKey?active.dataset[focusKey]:null;
    if(!dialog.querySelector('.production-detail-top'))dialog.innerHTML=`<div class="production-detail-top"><span></span><button class="icon-button" type="button" data-production="close-detail" aria-label="Закрыть этап">${app.icons.close}</button></div><div class="production-detail-body"></div>`;
    dialog.querySelector('.production-detail-top>span').textContent=isRoot?'Цель производства':'Этап цепочки';
    dialog.querySelector('.production-detail-body').innerHTML=`<div class="production-detail-title">${app.image(entry)}<div><h2>${esc(entry.name)}</h2><p>Нужно ${esc(countLabel(node))}</p></div></div>${parent?`<button class="production-parent" type="button" data-plan-node="${esc(parent.id)}">Для: ${esc(item(parent.itemId).name)} ${app.icons.right}</button>`:''}<div class="production-detail-content">${node.status==='unresolved'?`<p class="production-detail-warning">${esc(reasonLabel(node.reason))}. ${isRoot?'Выбери другой рецепт.':'Выбери другой рецепт или укажи этот предмет как готовое сырьё.'}</p>`:''}${recipeOptions.length?`<label class="production-field"><span>Способ получения · ${recipeOptions.length}</span><select data-recipe-choice="${esc(node.id)}"><option value=""${!node.recipeId?' selected':''}>Автоматически</option>${options}</select></label>`:`<p class="production-detail-note">В выгрузке нет подходящего рецепта этого предмета.</p>`}${node.status==='craft'?`<div class="production-facts"><div><span>Операций</span><strong>${num(node.batches)}</strong></div><div><span>За операцию</span><strong>${esc(amount(node.yield,node.unit))}</strong></div></div>`:''}${node.children?.length?`<div class="production-input-list"><h3>Потребуется</h3>${node.children.map(child=>`<button type="button" data-plan-node="${esc(child.id)}">${app.image(item(child.itemId))}<span>${esc(item(child.itemId).name)}</span><b>${esc(countLabel(child))}</b></button>`).join('')}</div>`:''}${choices}${outputChoices}${!isRoot?`<button class="production-base-toggle" type="button" data-production="toggle-base">${base||node.status==='base'&&node.reason==='user-base'?'Разобрать дальше':'Считать готовым сырьём'}</button>`:''}${(node.conditions||[]).length?`<details class="production-conditions"><summary>Условия</summary><ul>${node.conditions.map(condition=>`<li>${esc(condition)}</li>`).join('')}</ul></details>`:''}${selectedRecipe?.uncertain?`<p class="production-detail-note">У этого способа есть ненормализованные условия или случайный результат.</p>`:''}${node.reused>0?`<p class="production-detail-note">Из имеющегося остатка: ${esc(amount(node.reused,node.unit))}</p>`:''}<button class="production-text-button" type="button" data-production="view-recipe">Открыть рецепт ${app.icons.external}</button></div>`;
    const mobile=isMobile();$('production-body').classList.toggle('has-detail',!mobile);
    if(dialog.open&&dialog.dataset.modal!==String(mobile))dialog.close();
    dialog.dataset.modal=String(mobile);if(!dialog.open){if(mobile)dialog.showModal();else dialog.show();}
    openDetail=true;if(focusKey){([...dialog.querySelectorAll('button,select')].find(element=>element.dataset[focusKey]===focusValue)||dialog.querySelector('[data-production="close-detail"]'))?.focus({preventScroll:true});}else if(focus&&mobile)dialog.querySelector('[data-production="close-detail"]')?.focus({preventScroll:true});
    for(const element of $('production-world').querySelectorAll('[data-node-container]'))element.classList.toggle('selected',element.dataset.nodeContainer===selected);
  }
  async function copyMaterials(){
    if(!plan)return;const title=`${item(settings.target).name} × ${settings.count}`;
    const lines=[title,'','Сырьё:',...plan.baseMaterials.map(row=>`${item(row.itemId).name}: ${countLabel(row)}`)];
    if(plan.unresolvedMaterials?.length)lines.push('','Требует уточнения:',...plan.unresolvedMaterials.map(row=>`${item(row.itemId).name}: ${countLabel(row)} — ${reasonLabel(row.reason)}`));
    const text=lines.join('\n');
    try{await navigator.clipboard.writeText(text);const button=$('planner-view').querySelector('[data-production="copy"]');if(button){button.textContent='Скопировано';setTimeout(()=>{if(button.isConnected)button.textContent='Скопировать';},1800);}}
    catch{const blob=new Blob([text],{type:'text/plain;charset=utf-8'}),url=URL.createObjectURL(blob),link=document.createElement('a');link.href=url;link.download='uniland-materials.txt';link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
  }
  function clearBranch(path,includeRecipe=false){
    for(const key of Object.keys(settings.recipeChoices))if(key.startsWith(path+'/')||includeRecipe&&key===path)delete settings.recipeChoices[key];
    for(const store of [settings.inputChoices,settings.outputChoices])for(const key of Object.keys(store))if(key.startsWith(path+'/'))delete store[key];
  }
  function equivalentPaths(path){
    try{return window.UniLandPlanner.pathsForNode?window.UniLandPlanner.pathsForNode(plan,path):[path];}
    catch(reason){error='Слишком много связанных веток для одного изменения. Сначала выбери другой способ на предыдущем уровне.';renderStatus();showDetail(false);return null;}
  }
  function onChange(event){
    const control=event.target;
    if(control.dataset.recipeChoice!==undefined){const paths=equivalentPaths(control.dataset.recipeChoice);if(!paths)return;for(const key of paths){clearBranch(key);if(control.value)settings.recipeChoices[key]=control.value;else delete settings.recipeChoices[key];}schedule();}
    else if(control.dataset.inputChoice){const key=control.dataset.inputChoice,split=key.lastIndexOf('/in:'),suffix=key.slice(split),paths=equivalentPaths(key.slice(0,split));if(!paths)return;for(const parent of paths){const alias=parent+suffix;clearBranch(alias,true);settings.inputChoices[alias]=Number(control.value);}schedule();}
    else if(control.dataset.outputChoice){const key=control.dataset.outputChoice,split=key.lastIndexOf('/out:'),suffix=key.slice(split),paths=equivalentPaths(key.slice(0,split));if(!paths)return;for(const parent of paths)settings.outputChoices[parent+suffix]=Number(control.value);schedule();}
  }
  function onClick(event){
    const button=event.target.closest('button');if(!button||button.disabled)return;
    if(button.dataset.productionTab){switchTab(button.dataset.productionTab);return;}
    if(button.dataset.planOpenItem){closeDetail();app.setView('catalog');app.select(button.dataset.planOpenItem);return;}
    if(button.dataset.planNode){selected=button.dataset.planNode;showDetail();return;}
    if(button.dataset.planExpand){const id=button.dataset.planExpand;const visible=lastWorld?.positions.get(id)?.children.length;if(visible)expanded.delete(id);else expanded.add(id);if(visible&&id.split('/').length<2){/* First-level nodes stay explicit unless deliberately collapsed. */collapsedRoot.add(id);}else collapsedRoot.delete(id);renderGraph();return;}
    const action=button.dataset.production;
    if(action==='choose'){closeDetail();app.setView('catalog');$('search-input').focus();}
    else if(action==='less'||action==='more'){settings.count=Math.min(1000000,Math.max(1,settings.count+(action==='more'?1:-1)));$('production-quantity').value=settings.count;schedule();}
    else if(action==='zoom-in')viewport?.zoomBy(1.25);
    else if(action==='zoom-out')viewport?.zoomBy(.8);
    else if(action==='fit')viewport?.fit();
    else if(action==='close-detail')closeDetail();
    else if(action==='retry')compute();
    else if(action==='deeper'){nodeBudget=Math.min(9600,nodeBudget*2);schedule();}
    else if(action==='unresolved'){switchTab('materials');$('production-unresolved')?.scrollIntoView({block:'nearest'});}
    else if(action==='copy')copyMaterials();
    else if(action==='reset'){nodeBudget=1200;settings.recipeChoices={};settings.inputChoices={};settings.outputChoices={};settings.baseItems=[];settings.expandedItems=[];expanded.clear();expanded.add('root');collapsedRoot.clear();closeDetail();schedule(true);}
    else if(action==='toggle-base'){const node=currentNode();if(!node)return;const wasBase=bases().includes(node.itemId);settings.baseItems=settings.baseItems.filter(id=>id!==node.itemId);settings.expandedItems=settings.expandedItems.filter(id=>id!==node.itemId);if(wasBase)settings.expandedItems.push(node.itemId);else settings.baseItems.push(node.itemId);schedule();}
    else if(action==='view-recipe'){const node=currentNode();if(!node)return;closeDetail();app.setView('catalog');app.select(node.itemId);}
  }
  const collapsedRoot=new Set();
  function open(target,options={}){
    if(typeof target==='string'&&target&&app.ready&&!app.items.has(target)){generation++;settings.target=null;plan=null;busy=false;error='Предмет по этой ссылке отсутствует в текущей выгрузке.';app.setView('planner',{url:false});persist();render();return;}
    const changed=target&&target!==settings.target;
    if(target&&app.items.has(target)){
      settings.target=target;
      if(changed){nodeBudget=1200;settings.recipeChoices={};settings.inputChoices={};settings.outputChoices={};selected='root';expanded.clear();expanded.add('root');collapsedRoot.clear();plan=null;fitNext=true;}
    }
    if(options.count!==undefined)settings.count=Math.max(1,Math.min(1000000,Math.round(Number(options.count)||1)));
    if(settings.target&&!app.items.has(settings.target)&&app.ready)settings.target=null;
    app.setView('planner',{url:false});persist();syncUrl();
    if(app.ready&&settings.target&&(changed||!plan||plan.target.count!==settings.count))schedule(changed);else render();
  }
  function suspend(){closeDetail();if(viewport){canvasTransform=viewport.getTransform();canvasSize=viewport.getViewportSize();}viewport?.destroy();viewport=null;}
  window.UniLandProduction={open,render,suspend,isOpen:()=>app.state.view==='planner'};
  window.addEventListener('uniland-ready',()=>{primitiveIds=null;if(app.state.view==='planner'&&settings.target)schedule(true);});
})();
