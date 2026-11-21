// Match complete words and established phrases so, for example, "rest" does
// not match "restoration" and "service" does not match "Sunday Service."
const rules = new Map([
  ['Prayer', /\b(?:pray(?:er|ers|ing)?|intercession)\b/],
  ['Faith', /\b(?:faith|trust(?:ing)? god|doubt)\b/],
  ['Hope', /\b(?:hope|hopeful|hopelessness)\b/],
  ['Grace', /\bgrace\b/],
  ['Forgiveness', /\bforgiv(?:e|es|en|ing|eness)\b/],
  ['Salvation', /\b(?:salvation|saved by|born again|redemption)\b/],
  ['Jesus', /\bjesus\b/],
  ['Holy Spirit', /\b(?:holy spirit|pentecost)\b/],
  ['Worship', /\b(?:worship|praise god|praise and worship)\b/],
  ['Scripture', /\b(?:scripture|bible|word of god|bible study)\b/],
  ['Discipleship', /\b(?:discipleship|making disciples|follow(?:ing)? jesus)\b/],
  ['Service', /\b(?:serv(?:e|ing) others|servant heart|servanthood)\b/],
  ['Mission', /\b(?:missions?|missionar(?:y|ies))\b/],
  ['Evangelism', /\b(?:evangelism|sharing (?:the gospel|your faith)|great commission)\b/],
  ['Community', /\b(?:community|fellowship|belonging)\b/],
  ['Family', /\b(?:famil(?:y|ies)|parent(?:ing|hood)|motherhood|fatherhood)\b/],
  ['Relationships', /\b(?:relationships?|marriage|friendships?|dating)\b/],
  ['Grief', /\b(?:grief|grieving|mourning|bereavement)\b/],
  ['Suffering', /\b(?:suffer(?:ing)?|trials|hardship)\b/],
  ['Anxiety', /\b(?:anxiety|anxious|worry|worrying|fear)\b/],
  ['Peace', /\bpeace\b/],
  ['Joy', /\b(?:joy|joyful|rejoice)\b/],
  ['Love', /\b(?:love|loving|loved)\b/],
  ['Repentance', /\b(?:repent|repentance|repenting)\b/],
  ['Justice', /\b(?:justice|injustice)\b/],
  ['Generosity', /\b(?:generosity|generous|giving to others)\b/],
  ['Stewardship', /\b(?:stewardship|tith(?:e|es|ing)|biblical finances)\b/],
  ['Leadership', /\b(?:leadership|leading well|servant leader)\b/],
  ['Spiritual Growth', /\b(?:spiritual growth|spiritual maturity|spiritual formation|grow(?:ing)? in faith)\b/],
  ['Church', /\b(?:body of christ|being the church|local church|church unity)\b/],
  ['Resurrection', /\b(?:resurrection|easter|he is risen)\b/],
  ['Christmas', /\b(?:christmas|advent|nativity)\b/],
  ['Spiritual Gifts', /\b(?:spiritual gifts|gifts of the (?:holy )?spirit)\b/],
  ['Perseverance', /\b(?:perseverance|endurance|steadfastness|finish(?:ing)? the race)\b/],
  ['Identity', /\b(?:identity|who (?:you|we) are in christ)\b/],
  ['Wisdom', /\b(?:wisdom|discernment|wise choices)\b/],
  ['Humility', /\b(?:humility|being humble|humbling)\b/],
  ['Rest', /\b(?:rest|sabbath|burnout|resting in god)\b/],
  ['Temptation', /\b(?:temptation|tempted|overcoming sin)\b/],
  ['Baptism', /\b(?:baptism|baptized|baptised)\b/],
  ['Communion', /\b(?:communion|lord s supper|eucharist|breaking bread)\b/],
  ['Kingdom of God', /\b(?:kingdom of (?:god|heaven)|god s kingdom)\b/],
]);

function normalizeTitle(title) {
  return title.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

export function topicsForTitle(title) {
  const normalized = normalizeTitle(title);
  return [...rules].filter(([, rule]) => rule.test(normalized)).map(([topic]) => topic);
}

export function titleMatchesTopic(title, topic) {
  return rules.get(topic)?.test(normalizeTitle(title)) ?? false;
}
