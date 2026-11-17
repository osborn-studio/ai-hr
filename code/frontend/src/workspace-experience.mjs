const PERSONAL=['my/schedule','my/leave','my/payslips','my/requests','my/learning','my/alerts'];
const HR=['my/tasks','people','people/changes','attendance/monthly','payroll','people/contract-reminders'];
const EXPERIENCES={
 config_admin:{label:'系统配置管理员',title:'让规则清晰，\n让协作有序。',description:'维护操作人员、权限、审批流程与企业连接。',routes:['system/access','system/workflow','system/forms','integrations/runtime','integrations/connections','integrations/sso']},
 demo:{label:'全功能演示',title:'从一家门店，\n看见完整的人事业务。',description:'从组织人员进入，串联排班、考勤、绩效与薪酬。',routes:['organization','people','attendance/schedule','attendance/monthly','payroll','my/tasks']},
 boss:{label:'集团负责人',title:'看清人员配置，\n掌握每一份人力成本。',description:'查看授权范围内的成本、组织和经营用工情况。',routes:['reports/cost','organization','people','attendance/monthly','performance/bonus','my/alerts']},
 group_hr_director:{label:'集团HR总监',title:'统一人事底账，\n统筹集团各家门店。',description:'关注人员流动、考勤核准、薪酬结果与待办事项。',routes:HR},
 company_hr_director:{label:'公司HR总监',title:'连接人员与门店，\n把日常人事办清楚。',description:'在当前公司权限内核对人员、考勤、薪酬与合同。',routes:HR},
 hr_manager:{label:'HR主管',title:'每一件人事工作，\n都有清晰的进度。',description:'从待办和花名册进入，跟进人员变化与到期事项。',routes:HR},
 hr_staff:{label:'人事专员',title:'人员信息有据，\n日常办理有序。',description:'跟进入转调离、合同提醒与日常员工服务。',routes:['my/tasks','people','people/changes','people/contract-reminders','people/certificates','people/items']},
 recruiter:{label:'招聘专员',title:'从一次应聘，\n走向顺利入职。',description:'跟进招聘、面试和录用，并核对入职人员资料。',routes:['talent/recruit','people/changes','people','people/contracts','my/tasks','my/alerts']},
 payroll:{label:'薪酬专员',title:'算好每一份薪酬，\n核清每一笔来源。',description:'核对考勤与绩效，完成算薪、付款和申报。',routes:['payroll','attendance/monthly','performance/bonus','payroll/rules','payroll/finance','payroll/tax']},
 trainer:{label:'培训专员',title:'把学习落到岗位，\n让成长留下记录。',description:'安排课程、考试和阅卷，跟进岗位资格与结果应用。',routes:['learning/plans','learning/courses','learning/exams','learning/grading','learning/qualifications','my/tasks']},
 store_manager:{label:'店长',title:'排好每一个班，\n照顾每一家门店。',description:'查看门店人员、当日考勤、月报和待办事项。',routes:['attendance/schedule','attendance/daily','attendance/monthly','people','my/tasks','people/certificates']},
 store_staff:{label:'门店员工',title:'今天的班次，\n自己的安排，一眼清楚。',description:'查看排班、假期与工资单，跟进申请和学习进度。',routes:PERSONAL},
 station_staff:{label:'档口员工',title:'知道何时上班，\n看清自己的每份收获。',description:'在这里查看班次、请假余额、工资单和个人申请。',routes:PERSONAL},
 outsourced_staff:{label:'派驻服务人员',title:'工作安排清楚，\n沟通记录可查。',description:'查看本人班次和服务记录，处理申请与用工沟通。',routes:['my/schedule','services/workforce/collaboration','services/vendors','my/requests','my/learning','my/alerts']},
 outsource_hr:{label:'外包人事专员',title:'服务量有依据，\n供应商协作有进度。',description:'对照派驻安排、服务量和对账事项，跟进用工沟通。',routes:['services/vendors','services/workforce/reconciliation','services/workforce/collaboration','my/tasks','my/alerts']},
 vendor_contact:{label:'供应商联系人',title:'确认每份服务，\n跟进每笔对账。',description:'在授权范围内沟通服务安排、对账与结算。',routes:['services/workforce/reconciliation','services/workforce/collaboration','services/vendors','my/alerts']},
};
export function workspaceExperience(capabilities,pages=[]){
 const experience=EXPERIENCES[capabilities?.profile_code]||{label:'当前操作人员',title:'常用工作，\n从这里开始。',description:'按当前授权范围查看和办理业务。',routes:HR};
 // Presentation preferences never grant an entry: only supplied, currently
 // authorized pages can become shortcuts, including after role revocation.
 const allowed=pages.filter(p=>p.ready&&typeof p.access==='function'&&p.access(capabilities));
 const ordered=[...experience.routes.map(id=>allowed.find(p=>p.id===id)),...allowed];
 const seen=new Set(),shortcuts=ordered.filter(p=>p&&!seen.has(p.id)&&seen.add(p.id)).slice(0,6);
 return{...experience,shortcuts,availableCount:allowed.length};
}
export function operatorProfileLabel(capabilities,fallback){return EXPERIENCES[capabilities?.profile_code]?.label||fallback||'当前操作人员';}
