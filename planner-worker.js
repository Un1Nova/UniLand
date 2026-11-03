'use strict';
let planner = null;
self.addEventListener('message', async (event) => {
  const message = event.data || {};
  try {
    if (message.type === 'init') {
      const engineUrl = new URL(message.engineUrl, self.location.href);
      if (engineUrl.origin !== self.location.origin) throw new Error('Некорректный адрес расчётного модуля.');
      const catalogUrl=new URL(message.catalogUrl,self.location.href),decoderUrl=new URL(message.decoderUrl,self.location.href);
      if(catalogUrl.origin!==self.location.origin||decoderUrl.origin!==self.location.origin)throw new Error('Некорректный адрес каталога.');
      importScripts(decoderUrl.href,engineUrl.href);
      const response=await fetch(catalogUrl.href,{cache:'force-cache'});
      if(!response.ok)throw new Error('Не удалось загрузить данные для расчёта.');
      let catalog=await response.json();
      catalog=self.UniLandRuntime.decode(catalog);
      planner = self.UniLandPlanner.createPlanner(catalog);
      self.postMessage({type:'ready',requestId:message.requestId});
    } else if (message.type === 'plan') {
      if (!planner) throw new Error('Расчётный модуль ещё не загружен.');
      const result = planner.plan(message.options);
      self.postMessage({type:'result',requestId:message.requestId,result});
    }
  } catch (error) {
    self.postMessage({type:'error',requestId:message.requestId,error:error.message || String(error)});
  }
});
