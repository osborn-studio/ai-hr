-- New functional capabilities for existing built-in roles. This grants no new
-- company/group scope and does not alter user-defined roles or historical SQL.
INSERT INTO sys_role_resource(role_id,resource_code,can_read,can_write)
SELECT r.id,v.resource,true,v.write
FROM (VALUES
 ('ty_group_hr_director','advanced_leave_config',true),
 ('ty_group_hr_director','advanced_leave_manage',true),
 ('ty_group_hr_director','advanced_leave_approve',true),
 ('ty_group_hr_director','advanced_leave_payroll',true),
 ('ty_group_hr_director','advanced_leave_self',true),
 ('ty_company_hr_director','advanced_leave_config',true),
 ('ty_company_hr_director','advanced_leave_manage',true),
 ('ty_company_hr_director','advanced_leave_approve',true),
 ('ty_company_hr_director','advanced_leave_payroll',true),
 ('ty_company_hr_director','advanced_leave_self',true),
 ('ty_demo_hr_manager','advanced_leave_config',true),
 ('ty_demo_hr_manager','advanced_leave_manage',true),
 ('ty_demo_hr_manager','advanced_leave_approve',true),
 ('ty_demo_hr_manager','advanced_leave_payroll',true),
 ('ty_demo_config','advanced_leave_config',true),
 ('ty_demo_hr_staff','advanced_leave_config',false),
 ('ty_demo_hr_staff','advanced_leave_manage',true),
 ('ty_demo_payroll','advanced_leave_config',false),
 ('ty_demo_payroll','advanced_leave_manage',false),
 ('ty_demo_payroll','advanced_leave_payroll',true),
 ('store_mgr','advanced_leave_config',false),
 ('store_mgr','advanced_leave_manage',true),
 ('store_mgr','advanced_leave_approve',true),
 ('store_mgr','advanced_leave_self',true),
 ('store_staff','advanced_leave_self',true)
) v(role,resource,write) JOIN sys_role r ON r.code=v.role
ON CONFLICT(role_id,resource_code) DO NOTHING;
