-- Explicit, fully fictional login personas. Account login names are independent
-- from role codes; the demo login may hold the existing super role while the
-- admin login uses a restricted configuration role.
INSERT INTO sys_perm_resource(resource_code,label,temporal_basis) VALUES
 ('training_manage','培训考试管理','CURRENT'),
 ('employment_manage','人事雇佣管理','CURRENT'),
 ('people_self','员工：查看本人资料','CURRENT'),
 ('people_read_all','人员：按授权范围查看他人','CURRENT'),
 ('training_self','员工：本人培训考试','CURRENT')
ON CONFLICT(resource_code) DO NOTHING;

DO $$
DECLARE item record;
BEGIN
 FOR item IN SELECT * FROM (VALUES
  ('ty_demo_config','系统配置管理员','系统配置、组织基础、角色授权及制度；无业务算薪或绩效操作'),
  ('ty_demo_hr_manager','HR主管','集团内人事、招聘、薪酬、绩效、培训；不维护系统授权'),
  ('ty_demo_recruiter','招聘专员','招聘需求及招聘流程；人员资料按集团授权只读'),
  ('ty_demo_payroll','薪酬专员','工资、考勤与薪酬规则；人员资料只读'),
  ('ty_demo_trainer','培训专员','课程、场次、考试与培训记录；人员资料只读'),
  ('ty_demo_hr_staff','普通HR','基础人事、入离调转；不算薪或修改系统授权')
 ) AS v(code,name,description)
 LOOP
  IF NOT EXISTS(SELECT 1 FROM sys_role WHERE code=item.code) THEN
   INSERT INTO sys_role(id,code,name,description)
    SELECT greatest(1000,coalesce(max(id),0)+1),item.code,item.name,item.description FROM sys_role;
  END IF;
 END LOOP;
END $$;

INSERT INTO sys_role_resource(role_id,resource_code,can_read,can_write)
SELECT r.id,v.resource,true,v.write
FROM (VALUES
 ('ty_demo_config','ledger',true),('ty_demo_config','integration',true),('ty_demo_config','payroll_policy',true),
 ('ty_demo_hr_manager','employee_roster',true),('ty_demo_hr_manager','employment_manage',true),
 ('ty_demo_hr_manager','training_manage',true),('ty_demo_hr_manager','people_read_all',false),
 ('ty_demo_hr_manager','requisition',true),('ty_demo_hr_manager','perf_cycle',true),
 ('ty_demo_hr_manager','attendance_daily',true),('ty_demo_hr_manager','leave_request',true),
 ('ty_demo_hr_manager','headcount',true),('ty_demo_hr_manager','approval',true),
 ('ty_demo_hr_manager','payroll_run',true),('ty_demo_hr_manager','payroll_slips_read_all',false),
 ('ty_demo_hr_manager','payslip',false),('ty_demo_hr_manager','roster',true),
 ('ty_demo_hr_manager','punch',true),('ty_demo_hr_manager','att_report_approve',true),
 ('ty_demo_hr_manager','report',false),('ty_demo_hr_manager','person_document',true),('ty_demo_hr_manager','mpf_account',true),
 ('ty_demo_recruiter','requisition',true),('ty_demo_recruiter','employee_roster',false),
 ('ty_demo_recruiter','employment_manage',false),('ty_demo_recruiter','people_read_all',false),
 ('ty_demo_recruiter','headcount',false),
 ('ty_demo_payroll','payroll_run',true),('ty_demo_payroll','payroll_slips_read_all',false),
 ('ty_demo_payroll','payslip',true),('ty_demo_payroll','attendance_daily',true),
 ('ty_demo_payroll','att_report_approve',true),('ty_demo_payroll','roster',true),
 ('ty_demo_payroll','payroll_policy',true),('ty_demo_payroll','mpf_account',true),
 ('ty_demo_payroll','employee_roster',false),('ty_demo_payroll','employment_manage',false),
 ('ty_demo_payroll','people_read_all',false),('ty_demo_payroll','report',false),
 ('ty_demo_trainer','training_manage',true),('ty_demo_trainer','employee_roster',false),
 ('ty_demo_trainer','people_read_all',false),
 ('ty_demo_hr_staff','employee_roster',true),('ty_demo_hr_staff','employment_manage',true),
 ('ty_demo_hr_staff','people_read_all',false),('ty_demo_hr_staff','training_manage',false),
 ('ty_demo_hr_staff','leave_request',true),('ty_demo_hr_staff','attendance_daily',false),
 ('ty_demo_hr_staff','person_document',true),('ty_demo_hr_staff','roster',false),
 ('ty_demo_hr_staff','approval',true)
) AS v(role,resource,write) JOIN sys_role r ON r.code=v.role
ON CONFLICT(role_id,resource_code) DO NOTHING;

-- These capabilities use explicit self routes. They do not expand the generic
-- employee directory or give ordinary employees access to another payslip.
INSERT INTO sys_role_resource(role_id,resource_code,can_read,can_write)
SELECT r.id,v.resource,true,v.write FROM (VALUES
 ('store_staff','people_self',false),('store_staff','training_self',true),
 ('store_mgr','people_self',false),('store_mgr','people_read_all',false),('store_mgr','training_self',true),
 ('boss','people_read_all',false),('boss','people_self',false),('boss','training_self',false),
 ('boss','training_manage',false),('boss','employment_manage',false)
) AS v(role,resource,write) JOIN sys_role r ON r.code=v.role
ON CONFLICT(role_id,resource_code) DO NOTHING;

CREATE TABLE ty_test_account_profile (
 account_id bigint PRIMARY KEY REFERENCES sys_account(id),
 group_id bigint NOT NULL REFERENCES ty_group(id),
 person_id bigint REFERENCES ty_person(id),
 company_id bigint REFERENCES ty_company(id),
 work_area_id bigint REFERENCES ty_work_area(id),
 profile_code varchar(32) NOT NULL CHECK(profile_code IN
  ('config_admin','demo','boss','hr_manager','recruiter','payroll','trainer','hr_staff',
   'store_manager','store_staff','station_staff')),
 seed_version varchar(32) NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 CHECK((profile_code IN ('store_manager','store_staff','station_staff'))=(person_id IS NOT NULL)),
 CHECK((person_id IS NOT NULL)=(company_id IS NOT NULL)),
 FOREIGN KEY(person_id,group_id) REFERENCES ty_person(id,group_id),
 FOREIGN KEY(company_id,group_id) REFERENCES ty_company(id,group_id)
);
CREATE UNIQUE INDEX ux_ty_test_account_person ON ty_test_account_profile(group_id,person_id) WHERE person_id IS NOT NULL;
COMMENT ON TABLE ty_test_account_profile IS '显式全虚构演示账号归属；不存明文口令、不自动接管已有同名账号。';
