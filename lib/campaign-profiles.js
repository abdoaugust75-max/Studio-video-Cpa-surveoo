'use strict';

const PROFILES = [
  { key: 'alshihna', idea: 'Clear product discovery for the wider Arabic audience', language: 'Simple Modern Standard Arabic', accent: 'Clear neutral Modern Standard Arabic', audience: 'Arabic-speaking shoppers', color: '#f0a14b' },
  { key: 'maghrebtechstore', idea: 'Moroccan tech curiosity, hands-on unboxing and practical gadget choices', language: 'Moroccan Darija in Arabic script', accent: 'Authentic Moroccan Darija', audience: 'Moroccan technology shoppers', color: '#57b5f4' },
  { key: 'maghrebly', idea: 'Useful technology for Moroccan families and the diaspora', language: 'Moroccan Darija in Arabic script', accent: 'Authentic Moroccan Darija', audience: 'Moroccan families and diaspora', color: '#ba91f5' },
  { key: 'mubadara', idea: 'Accessible technology and practical everyday uses for young people', language: 'Moroccan Darija in Arabic script', accent: 'Authentic Moroccan Darija', audience: 'Moroccan young people', color: '#f18db3' },
  { key: 'tashilat', idea: 'Practical buying decisions, budgeting and checking payment conditions', language: 'Moroccan Darija in Arabic script', accent: 'Authentic Moroccan Darija', audience: 'Moroccan shoppers comparing payment options', color: '#69d5bc' },
  { key: 'amazon_liquidation', idea: 'Warehouse-style product inspection and what is inside the package', language: 'Moroccan Darija in Arabic script', accent: 'Authentic Moroccan Darija', audience: 'Moroccan smart-device shoppers', color: '#e0c45b' },
  { key: 'vouchteck', idea: 'Global gadget discovery and clear, exciting product curiosity', language: 'Simple international English', accent: 'Clear international English', audience: 'Worldwide technology shoppers', color: '#fa956f' },
];
function profileFor(key) { return PROFILES.find(p => p.key === key) || null; }
module.exports = { PROFILES, profileFor };
