const surname=['周','陈','许','郑','王','顾','陆','程','叶','林','沈','赵','吴','梁','苏','方','唐','徐','江','冯','朱','孟','何','宋','刘','马','姚','杜','黄','曹','孙'];
const given=['嘉禾','知宁','锦安','亦辰','沐言','景和','清越','舒然','承宇','星澄','予安','思远','云舒','明轩','芷晴','若涵','子衡','悦宁','文熙','佳音','向晨','以安','欣然','晓棠','奕川','书瑶','可欣','语桐','雨澄','安禾','知行'];
export function demoPersonName(index){return surname[index%surname.length]+given[(index*7+Math.floor(index/surname.length)*3)%given.length];}
