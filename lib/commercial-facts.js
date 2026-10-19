'use strict';
const normalize=s=>String(s||'').toLowerCase().replace(/[^a-z0-9\u0600-\u06ff]/g,'');
const digits=s=>String(s||'').replace(/[٠-٩]/g,c=>String(c.charCodeAt(0)-1632)).replace(/[۰-۹]/g,c=>String(c.charCodeAt(0)-1776));
const currency={test:s=>/(?:درهم|دراهم|ريال|دولار|يورو|جنيه|دينار|\b(?:dollars?|pounds?|euros?)\b|[$€£])/i.test(s)||/\b(?:DH|MAD|USD|EUR|SAR|AED)\b/.test(s)||/[0-9٠-٩]\s*(?:dh|mad|usd|eur|sar|aed)\b/i.test(s)};
function money(s){const raw=digits(s),last=Math.max(raw.lastIndexOf('.'),raw.lastIndexOf(',')),decimals=last>=0?raw.length-last-1:0;const normalized=last>=0&&decimals>0&&decimals<=2?raw.slice(0,last).replace(/[,.]/g,'')+'.'+raw.slice(last+1):raw.replace(/[,.]/g,'');return Number(normalized).toFixed(2);}
function scopedCommercialFacts({analysis,presentation,approvedFacts=''}){
  // Product metadata can be wrong. Scope selling prices to visual evidence, not
  // a source caption, owner style instruction or a winning reference's claims.
  const evidence=normalize(JSON.stringify(analysis?.timeline||[]));
  const prices=(presentation?.prices||[]).filter(p=>normalize(p.product).length>=3&&evidence.includes(normalize(p.product)));
  const lines=String(approvedFacts).split(/\r?\n/).filter(line=>{
    if(!(currency.test(line)||/[=:]\s*[0-9٠-٩۰-۹]/.test(line))||!/[0-9٠-٩۰-۹]/.test(line))return true;
    const clean=line.replace(/^\s*\[\d+\]\s*/,''),prefix=clean.split(/\s*[=:]\s*|\b\d[\d ,.]*\s*(?:dh|mad|usd|eur|sar|aed)\b/i)[0];
    const product=normalize(prefix);return product.length>=3&&evidence.includes(product);
  });
  const text=lines.join('\n');const amounts=new Set();
  for(const price of prices)for(const n of digits(price.price).match(/\d+(?:[.,]\d+)*/g)||[])amounts.add(money(n));
  for(const line of lines.filter(line=>currency.test(line))){const tail=digits(line).split(/[=:]/).slice(1).join(':');if(tail)for(const n of tail.match(/\d+(?:[.,]\d+)*/g)||[])amounts.add(money(n));}
  return{prices,text,amounts:[...amounts],note:'Only the visually matching product has an approved price. Missing price means omit it, even if the owner asks to start with price.'};
}
function scriptPriceError(text,scope){
  const s=digits(text).replace(/https?:\/\/\S+/gi,'');if(!currency.test(s)&&!/(?:ثمن|سعر|price|cost).{0,20}\d/i.test(s))return null;
  if(!scope.amounts.length)return 'Currency/price mentioned without a verified price for the visible product';
  const amounts=[...s.matchAll(/(?:[$€£]\s*(\d+(?:[.,]\d+)*)|(\d+(?:[.,]\d+)*)\s*(?:درهم|دراهم|ريال|دولار|يورو|جنيه|دينار|dh\b|mad\b|usd\b|eur\b|sar\b|aed\b|dollars?\b|pounds?\b|euros?\b))/gi)].map(m=>money(m[1]||m[2]));
  for(const match of s.matchAll(/(?:ثمن|سعر|price|cost)[^0-9]{0,20}(\d+(?:[.,]\d+)*)/gi))amounts.push(money(match[1]));
  if(!amounts.length)return 'Write an approved numeric price exactly or omit the currency; spoken-word amounts cannot be verified automatically';
  return amounts.some(n=>!scope.amounts.includes(n))?'Price does not match a verified price for the visible product':null;
}
module.exports={scopedCommercialFacts,scriptPriceError};
