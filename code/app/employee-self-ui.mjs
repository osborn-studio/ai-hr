const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const display=v=>v===null||v===undefined||v===''?'—':esc(v);
const day=v=>v?esc(String(v).slice(0,10)):'—';
const money=(v,c)=>v===null||v===undefined?'—':`${Number(v).toLocaleString('zh-CN',{minimumFractionDigits:2,maximumFractionDigits:2})} ${esc(c||'')}`;
const labels={invited:'待参加',enrolled:'已报名',attended:'已到场',completed:'已结业',cancelled:'已取消',earning:'收入',deduction:'业务扣款',employee_contribution:'员工承担',employer_contribution:'企业承担'};
let lastToken;const pages={pay:1,training:1,paper:1};let selectedYear,leaveReceipt;
const pager=(kind,total,size)=>`<div class="pagination"><span>共 ${total} 条 · 第 ${pages[kind]} / ${Math.max(1,Math.ceil(total/size))} 页</span><button data-page="${kind}" data-direction="-1" ${pages[kind]<=1?'disabled':''}>上一页</button><button data-page="${kind}" data-direction="1" ${pages[kind]*size>=total?'disabled':''}>下一页</button></div>`;
const slice=(kind,rows,size)=>{pages[kind]=Math.max(1,Math.min(pages[kind],Math.ceil(rows.length/size)||1));return rows.slice((pages[kind]-1)*size,pages[kind]*size);};

export async function renderEmployeeSelf({kind,container,request,me,token,isCurrent=()=>true,toast=()=>{}}){
  if(lastToken!==token){lastToken=token;pages.pay=pages.training=pages.paper=1;selectedYear=undefined;leaveReceipt=null;}
  const render=()=>renderEmployeeSelf({kind,container,request,me,token,isCurrent,toast});
  const title=kind==='pay'?'我的工资':kind==='leave'?'我的假期':'我的培训与考试';
  container.innerHTML=`<div class="page-heading"><div><h1>${title}</h1><p>当前账号仅查看与处理本人资料。</p></div></div><section class="card"><p class="muted">正在读取…</p></section>`;
  try{
    if(kind==='leave'){
      const [balance,types]=await Promise.all([request('/api/leave/balance'),request('/api/leave/types')]);if(!isCurrent())return;
      const rows=balance.rows||[],choices=(types.rows||[]).filter(t=>t.is_active);
      container.innerHTML=`<div class="page-heading"><div><h1>我的假期</h1><p>本人额度与请假申请，审批结果由业务流程记录。</p></div><button data-reload>刷新</button></div><section class="card"><h2>我的额度</h2><div class="table-wrap"><table><thead><tr><th>假种</th><th>已授予</th><th>冻结中</th><th>已使用</th><th>可用</th></tr></thead><tbody>${rows.map(r=>`<tr><td>${display(r.name)}</td><td>${display(r.granted)}</td><td>${display(r.frozen)}</td><td>${display(r.used)}</td><td>${display(r.available)}</td></tr>`).join('')||'<tr><td colspan="5">尚未维护本人假期额度，请联系HR维护适用制度和额度。</td></tr>'}</tbody></table></div></section><section class="card"><h2>提交请假申请</h2>${leaveReceipt?`<p class="notice">申请 ${display(leaveReceipt.request_id)} 已提交，状态：待审批。</p>`:''}<form id="selfLeaveForm" class="self-leave-form"><label>假种<select name="type" required>${choices.map(t=>`<option value="${Number(t.id)}">${display(t.name)}</option>`).join('')}</select></label><label>开始日期<input type="date" name="from" required></label><label>结束日期<input type="date" name="to" required></label><label>申请天数<input type="number" name="qty" min="0.5" step="0.5" required></label><p class="form-error" hidden></p><button class="primary" type="submit" ${choices.length?'':'disabled'}>提交本人申请</button></form></section>`;
      const form=container.querySelector('form');form.onsubmit=async event=>{event.preventDefault();const button=event.submitter;button.disabled=true;const values=new FormData(form);try{leaveReceipt=await request('/api/leave/apply?'+new URLSearchParams([...values.entries()]),{method:'POST'});render();}catch(error){const message=form.querySelector('.form-error');message.textContent=error.message;message.hidden=false;button.disabled=false;}};
    }else if(kind==='pay'){
      const data=await request('/api/customer-payroll/my');if(!isCurrent())return;
      const rows=Array.isArray(data.rows)?data.rows:[],shown=slice('pay',rows,10);
      container.innerHTML=`<div class="page-heading"><div><h1>我的工资</h1><p>查看本人已确认的工资核算。确认结果与实际付款分别记录。</p></div><button data-reload>刷新</button></div><section class="card">${shown.map(r=>`<details class="self-pay-period"><summary><strong>${display(r.period)} · ${display(r.company_name)}</strong><span>实发 ${money(r.totals?.net_pay,r.currency)}</span></summary><p class="muted">${display(r.full_name)} · ${display(r.person_number)}</p><div class="self-pay-totals"><span>应发 <b>${money(r.totals?.income_total,r.currency)}</b></span><span>员工承担 <b>${money(r.totals?.employee_contribution,r.currency)}</b></span><span>企业承担 <b>${money(r.totals?.employer_contribution,r.currency)}</b></span></div><div class="table-wrap"><table><thead><tr><th>工资项</th><th>类型</th><th>金额</th></tr></thead><tbody>${(r.items||[]).map(item=>`<tr><td>${display(item.name||item.code)}</td><td>${display(labels[item.kind]||item.kind)}</td><td>${money(item.amount,r.currency)}</td></tr>`).join('')}</tbody></table></div></details>`).join('')||'<div class="empty-state"><h2>暂无已确认工资</h2><p>工资核算确认后会在这里显示。</p></div>'}${pager('pay',rows.length,10)}</section>`;
    }else{
      const year=selectedYear||String(me.today||'').slice(0,4)||String(new Date().getFullYear());
      const [training,exams]=await Promise.all([request('/api/training/my?year='+encodeURIComponent(year)),request('/api/exam/my-board')]);if(!isCurrent())return;
      const rows=Array.isArray(training.rows)?training.rows:[],papers=Array.isArray(exams.papers)?exams.papers:[],shown=slice('training',rows,15),paperShown=slice('paper',papers,15);
      container.innerHTML=`<div class="page-heading"><div><h1>我的培训与考试</h1><p>按课程查看本人学时，使用本人身份参加考试。</p></div><button data-reload>刷新</button></div><section class="card"><div class="toolbar"><label>年度 <input id="selfTrainingYear" type="number" min="1900" max="9998" value="${esc(year)}"></label><span>已结业学时 ${display(training.hours??0)}</span></div><div class="table-wrap"><table><thead><tr><th>课程</th><th>日期</th><th>状态</th><th>到场 / 标准学时</th></tr></thead><tbody>${shown.map(r=>`<tr><td>${display(r.course_name)}</td><td>${day(r.starts_at)}</td><td>${display(labels[r.status]||r.status)}</td><td>${display(r.attended_hours)} / ${display(r.std_hours)}</td></tr>`).join('')||'<tr><td colspan="4">本年度暂无培训记录</td></tr>'}</tbody></table></div>${pager('training',rows.length,15)}</section><section class="card"><h2>我的考试</h2><div class="table-wrap"><table><thead><tr><th>试卷</th><th>课程</th><th>已考 / 剩余</th><th>最高分</th><th>操作</th></tr></thead><tbody>${paperShown.map(p=>`<tr><td>${display(p.name)}</td><td>${display(p.course_name)}</td><td>${display(p.used??0)} / ${p.left_attempts===null?'不限':display(p.left_attempts)}</td><td>${display(p.best_score)}</td><td><button data-my-paper="${Number(p.id)}" ${p.left_attempts!==null&&Number(p.left_attempts)<=0?'disabled':''}>开始考试</button></td></tr>`).join('')||'<tr><td colspan="5">暂无可参加的试卷</td></tr>'}</tbody></table></div>${pager('paper',papers.length,15)}</section>`;
      container.querySelector('#selfTrainingYear').onchange=e=>{selectedYear=e.target.value;pages.training=1;render();};
      container.querySelectorAll('[data-my-paper]').forEach(button=>button.onclick=()=>startExam(Number(button.dataset.myPaper),{request,me,isCurrent,toast,render}));
    }
    container.querySelectorAll('[data-page]').forEach(button=>button.onclick=()=>{pages[button.dataset.page]+=Number(button.dataset.direction);render();});
    container.querySelector('[data-reload]').onclick=render;
  }catch(error){if(isCurrent())container.innerHTML=`<section class="card"><h2>${title}</h2><p class="notice error">${esc(error.message)}</p><button data-retry>重试</button></section>`;container.querySelector('[data-retry]')?.addEventListener('click',render);}
}

async function startExam(paperId,{request,me,isCurrent,toast,render}){
  try{
    const started=await request(`/api/exam/start?paper=${paperId}&employee=${Number(me.person_id)}`,{method:'POST'}),paper=await request(`/api/exam/paper?paper=${paperId}`);if(!isCurrent())return;
    let dialog=document.querySelector('#selfExamDialog');if(!dialog){dialog=document.createElement('dialog');dialog.id='selfExamDialog';dialog.className='customer-dialog self-exam-dialog';document.body.append(dialog);}
    dialog.innerHTML=`<form><div class="dialog-heading"><h2>${display(paper.name)}</h2><button type="button" data-close>关闭</button></div><p class="muted">第 ${display(started.attempt_no)} 次作答${started.deadline_at?' · 截止 '+display(String(started.deadline_at).replace('T',' ').slice(0,16)):''}。提交后按试卷规则判分。</p>${(paper.questions||[]).map((q,i)=>`<fieldset class="self-exam-question"><legend>${i+1}. ${display(q.stem)}（${display(q.score)}分）</legend>${(q.options||[]).map(o=>`<label><input type="${q.kind==='multi'?'checkbox':'radio'}" name="q${Number(q.id)}" value="${esc(o.k)}"> ${display(o.k)}. ${display(o.t)}</label>`).join('')}</fieldset>`).join('')}<p class="form-error" hidden></p><button class="primary" type="submit">提交答卷</button></form>`;
    dialog.querySelector('[data-close]').onclick=()=>dialog.close();
    dialog.querySelector('form').onsubmit=async event=>{
      event.preventDefault();const button=event.submitter;button.disabled=true;
      try{
        const answers=(paper.questions||[]).map(q=>({q:q.id,picked:[...dialog.querySelectorAll(`[name="q${Number(q.id)}"]:checked`)].map(el=>el.value).sort().join(',')}));
        const result=await request(`/api/exam/submit?attempt=${Number(started.attempt_id)}&answers=${encodeURIComponent(JSON.stringify(answers))}`,{method:'POST'});
        dialog.innerHTML=`<h2>${result.passed?'考试通过':'本次未通过'}</h2><p>得分 ${display(result.score)} / ${display(result.total_score)}</p><p>答对 ${display(result.right_count)} / ${display(result.question_count)} 题</p><button>关闭</button>`;
        dialog.querySelector('button').onclick=()=>{dialog.close();if(isCurrent())render();};
      }catch(error){dialog.querySelector('.form-error').textContent=error.message;dialog.querySelector('.form-error').hidden=false;button.disabled=false;}
    };
    dialog.showModal();
  }catch(error){toast(error.message,true);}
}
