import React,{useRef,useState}from'react';
const KEY='tyhr.organization.split';
const clamp=value=>Math.max(30,Math.min(70,value));
export default function ResizableOrganization({children}){
 const host=useRef(null),[width,setWidth]=useState(()=>{try{const v=Number(localStorage.getItem(KEY));return v>=30&&v<=70?v:52;}catch{return 52;}});
 const update=value=>{const next=clamp(value);setWidth(next);try{localStorage.setItem(KEY,String(next));}catch{}};
 const move=e=>{if(!e.currentTarget.hasPointerCapture(e.pointerId))return;const box=host.current.getBoundingClientRect();update((e.clientX-box.left)/box.width*100);};
 return <div ref={host} className="hr-organization-layout" style={{'--org-left':width+'%'}}>{children[0]}<div className="hr-org-splitter" role="separator" aria-label="调整组织图与人员详情宽度" aria-orientation="vertical" aria-valuemin={30} aria-valuemax={70} aria-valuenow={Math.round(width)} tabIndex={0} title="拖动调整宽度，双击恢复；方向键微调" onPointerDown={e=>{if(e.button!==0)return;e.preventDefault();e.currentTarget.setPointerCapture(e.pointerId);}} onPointerMove={move} onPointerUp={e=>{if(e.currentTarget.hasPointerCapture(e.pointerId))e.currentTarget.releasePointerCapture(e.pointerId);}} onDoubleClick={()=>update(52)} onKeyDown={e=>{if(['ArrowLeft','ArrowRight','Home','End'].includes(e.key)){e.preventDefault();update(e.key==='Home'?30:e.key==='End'?70:width+(e.key==='ArrowLeft'?-2:2));}}}><span/></div>{children[1]}</div>;
}
