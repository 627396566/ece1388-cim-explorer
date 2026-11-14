/* Worked references from recorded execution acceptance, never DUT replacement.
 *
 * CommonJS exports and browser global: FlexLessons.buildLessons(trace),
 * FlexLessons.getLessonAt(lessons, timeFs, selectedId=null, eventCursor=Infinity).
 * Event indices are zero-based; runtime.cursor is the number of consumed events.
 *
 * Task: {id,start_fs,start_event_index,end_fs,end_event_index,completed_fs,
 *   status,descriptor:{input_bits,weight_bits,input_count,weight_slot,blk_mask,
 *   selected_blks},input:{raw:[Word*64],effective:[Word*64],padding_count},
 *   blocks:[{blk,power,ready,weight_valid,stored_weights:[Word*64],
 *     effective_weights:[Word*64],reference:{dot:Word,planes:[{bit,
 *       input_bits:[logic*64],products:[Word*64],psum:Word,acc_before:Word,
 *       acc_after:Word}]},recorded:{result:null|Sample,psum_samples:[Sample],
 *       acc_samples:[Sample],delivery_fs,delivery_event_index,comparison}}],issues}.
 * Word: {value:number|null,bits:MSB-first string containing 0/1/X/Z/?}.
 * Sample: {time_fs,event_index,word:Word,bit?}. References use the accepted
 * C-buffer and SRAM snapshot. Recorded fields use later register events.
 * completed_fs marks all final result-valid assertions, not host delivery.
 * getLessonAt returns {lesson,phase,reference_is_future,recorded}; recorded is
 * cursor-filtered. lesson contains the complete case for reference inspection.
 */
(function(root,factory){
  const api=factory();
  if(typeof module!=="undefined" && module.exports)module.exports=api;
  if(root)root.FlexLessons=api;
})(typeof globalThis!=="undefined"?globalThis:this,function(){
  "use strict";
  const cachedTopology=new WeakMap();
  const logic=v=>v===0||v==="0"?"0":v===1||v==="1"?"1":v==="Z"?"Z":v==="?"?"?":"X";
  const known=(n,width)=>({value:n,bits:n.toString(2).padStart(width,"0")});
  const unknown=width=>({value:null,bits:"X".repeat(width)});
  const wordFromBits=bits=>({value:bits.every(x=>x==="0"||x==="1")?parseInt(bits.slice().reverse().join(""),2):null,bits:bits.slice().reverse().join("")});
  const multiply=(a,b,width)=>a.value===0||b.value===0?known(0,width):a.value===null||b.value===null?unknown(width):known(a.value*b.value,width);
  const sum=(items,width)=>items.some(x=>x.value===null)?unknown(width):known(items.reduce((n,x)=>n+x.value,0),width);
  const visible=(sample,time,cursor)=>sample!==null && sample.time_fs<=time && sample.event_index<cursor;

  function graph(trace){
    if(cachedTopology.has(trace.nets))return cachedTopology.get(trace.nets);
    const names=new Map(trace.nets.map((n,i)=>[n,i]));
    const sigs=new Map((trace.signals||[]).map(s=>[s.id,s.bits]));
    const index=name=>names.has(name)?names.get(name):-1;
    const bits=(id,prefix,width)=>sigs.get(id)||Array.from({length:width},(_,j)=>index(`${prefix}[${j}]`));
    const scalar=(id,name)=>sigs.get(id)?.[0]??index(name);
    const g={root:scalar("clk_root","F.clk_root"),reset:index("F.rst_n"),
      start:scalar("op_start","E.op_start"),ready:scalar("op_ready","B.op_ready"),
      op:bits("op_code","E.op_code",3),mask:bits("exec_mask","E.exec_mask",16),
      a:bits("input_bits_m1","E.input_bits_m1",3),w:bits("weight_bits_m1","E.weight_bits_m1",3),
      count:bits("count_m1","E.count_m1",6),slot:bits("slot","E.slot",3),
      plane:bits("plane_bit","B.plane_bit",3),power:bits("blk_pwr_en","E.blk_pwr_en",16),
      blkReady:bits("blk_ready","E.blk_ready",16),takes:bits("result_take","D.result_take",16),
      c:Array.from({length:64},(_,k)=>Array.from({length:8},(_,j)=>index(`C.word${k}.q[${j}]`))),
      sram:Array.from({length:16},()=>Array.from({length:8},()=>Array.from({length:64},()=>Array(8).fill(-1)))),
      blocks:[],watchers:new Map(),clockBlocks:new Map()};
    if(g.root<0||g.start<0||g.ready<0||g.op.some(n=>n<0))throw new Error("Lesson extraction requires recorded E/B execution-handshake nets and the buffered root clock.");
    for(const c of trace.cells||[]){
      if(g.sram[c.blk]?.[c.slot]?.[c.term] && c.bit>=0 && c.bit<8)g.sram[c.blk][c.slot][c.term][c.bit]=c.q;
    }
    for(let b=0;b<16;b++){
      const local={psum:bits(`A.blk${b}.psum`,`A.blk${b}.psum`,14),result:bits(`A.blk${b}.result`,`A.blk${b}.result`,22),
        valid:scalar(`A.blk${b}.result_valid`,`A.blk${b}.result_valid`),psumValid:index(`A.blk${b}.psum_valid`),
        clock:scalar(`B.local${b}.clock`,`B.local${b}.clock_gate.out`),
        slotValid:bits(`E.valid${b}`,`E.weight_valid[${b}]`,8),delay:null};
      const flop=(trace.devices||[]).find(d=>d.name===`A.blk${b}.accumulator.ff0`);
      if(flop && Number.isFinite(flop.delay_fs))local.delay=flop.delay_fs;
      g.blocks.push(local);
      if(local.clock>=0)g.clockBlocks.set(local.clock,b);
      for(const [kind,ids] of [["psum",local.psum],["result",local.result],["valid",[local.valid]],["psumValid",[local.psumValid]]]){
        for(const n of ids)if(n>=0){if(!g.watchers.has(n))g.watchers.set(n,[]);g.watchers.get(n).push({blk:b,kind});}
      }
    }
    cachedTopology.set(trace.nets,g);return g;
  }

  function buildLessons(trace){
    if(!Array.isArray(trace.nets)||!Array.isArray(trace.initial)||!Array.isArray(trace.events))throw new Error("Lesson extraction requires the complete trace and topology.");
    const g=graph(trace),values=trace.initial.slice(),lessons=[];
    const bit=n=>n>=0&&n<values.length?logic(values[n]):"?";
    const word=ids=>wordFromBits(ids.map(bit));
    let active=null,pending=[],previousTime=-Infinity;
    const sample=(time,event,ids,extra={})=>({time_fs:time,event_index:event,word:word(ids),...extra});
    const blockOf=blk=>active?.blocks.find(b=>b.blk===blk);
    function begin(time,event){
      const a=word(g.a).value,w=word(g.w).value,count=word(g.count).value,slot=word(g.slot).value,mask=word(g.mask).value;
      if([a,w,count,slot,mask].some(x=>x===null))throw new Error("Accepted compute descriptor contains unknown bits; cannot construct a numerical lesson.");
      if(active && active.end_fs===null){active.status="interrupted";active.end_fs=time;active.end_event_index=event;active.issues.push("A later execution handshake occurred before this task completed delivery.");}
      const raw=g.c.map(word),effective=raw.map((x,i)=>i<=count?x:known(0,8));
      active={id:`compute-${lessons.length+1}`,start_fs:time,start_event_index:event,end_fs:null,end_event_index:null,
        completed_fs:null,completed_event_index:null,status:"running",descriptor:{input_bits:a+1,weight_bits:w+1,input_count:count+1,weight_slot:slot,blk_mask:mask,selected_blks:[]},
        input:{raw,effective,padding_count:63-count},blocks:[],issues:[]};
      for(let b=0;b<16;b++)if(mask&(1<<b)){
        active.descriptor.selected_blks.push(b);
        const stored=g.sram[b][slot].map(word),effectiveWeights=stored.map(x=>wordFromBits(x.bits.split("").reverse().map((v,j)=>j<=w?v:"0")));
        const products=effective.map((x,t)=>multiply(x,effectiveWeights[t],16));
        let accumulator=known(0,22);const planes=[];
        for(let p=a;p>=0;p--){
          const inputs=effective.map(x=>x.bits[7-p]);
          const terms=inputs.map((v,t)=>multiply(wordFromBits([v]),effectiveWeights[t],14));
          const psum=sum(terms,14),before=accumulator;
          accumulator=before.value===null||psum.value===null?unknown(22):known(2*before.value+psum.value,22);
          planes.push({bit:p,input_bits:inputs,products:terms,psum,acc_before:before,acc_after:accumulator});
        }
        const block={blk:b,power:bit(g.power[b]),ready:bit(g.blkReady[b]),weight_valid:bit(g.blocks[b].slotValid[slot]),stored_weights:stored,effective_weights:effectiveWeights,
          reference:{products,dot:sum(products,22),planes},recorded:{result:null,psum_samples:[],acc_samples:[],delivery_fs:null,delivery_event_index:null,comparison:null}};
        if(block.power!=="1"||block.ready!=="1"||block.weight_valid!=="1")active.issues.push(`BLK ${b}: accepted task has unconfirmed power, readiness, or slot validity.`);
        active.blocks.push(block);
      }
      lessons.push(active);
    }
    function abort(time,event,reason){
      if(active && active.end_fs===null){active.status="aborted";active.end_fs=time;active.end_event_index=event;active.issues.push(reason);pending=[];}
    }
    function flushPending(time,lastIndex,changes){
      const remaining=[];
      for(const entry of pending){
        if(entry.time<=time){
          const b=blockOf(entry.blk);
          if(b && active.status!=="aborted"){
            const changed=changes?.get(entry.blk)?.result??-1;
            // A no-change Q commit still follows its recorded clock edge and
            // the exported DFF delay. It is not a reference arithmetic result.
            const event=Math.max(entry.event,changed>=0?changed:lastIndex);
            b.recorded.acc_samples.push(sample(entry.time,event,g.blocks[entry.blk].result,{bit:entry.bit}));
          }
        }else remaining.push(entry);
      }
      pending=remaining;
    }
    for(let i=0;i<trace.events.length;){
      const time=trace.events[i][0];
      if(time<previousTime)throw new Error("Lesson events must be in chronological order.");
      previousTime=time;
      if(pending.some(p=>p.time<time))flushPending(time-1,i-1,null);
      const changes=new Map();let j=i;
      for(;j<trace.events.length&&trace.events[j][0]===time;j++){
        const [,n,value]=trace.events[j],old=bit(n),next=logic(value);
        if(n===g.root && old==="0" && next==="1"){
          if(bit(g.start)==="1"&&bit(g.ready)==="1"&&word(g.op).value===2)begin(time,j);
          if(active && active.end_fs===null){
            for(const b of active.blocks)if(bit(g.takes[b.blk])==="1"&&b.recorded.delivery_fs===null){b.recorded.delivery_fs=time;b.recorded.delivery_event_index=j;}
            if(active.blocks.length && active.blocks.every(b=>b.recorded.delivery_fs!==null)){active.end_fs=time;active.end_event_index=j;active.status="delivered";}
          }
        }
        if(n===g.reset && next==="0" && old!=="0")abort(time,j,"Global reset aborted this task before delivery.");
        if(active && active.end_fs===null){
          const clkBlk=g.clockBlocks.get(n);
          if(clkBlk!==undefined&&old==="0"&&next==="1"&&bit(g.blocks[clkBlk].psumValid)==="1"){
            const b=blockOf(clkBlk),delay=g.blocks[clkBlk].delay;
            if(b && delay!==null)pending.push({time:time+delay,event:j,blk:clkBlk,bit:b.recorded.psum_samples.at(-1)?.bit??null});
          }
          if(next==="0"&&old!=="0"&&active.blocks.some(b=>g.power[b.blk]===n))abort(time,j,"A selected BLK lost power before task delivery.");
        }
        values[n]=value;
        for(const watcher of g.watchers.get(n)||[]){
          if(!changes.has(watcher.blk))changes.set(watcher.blk,{});
          const c=changes.get(watcher.blk);c[watcher.kind]=j;
          if(watcher.kind==="valid"&&old!=="1"&&next==="1")c.validRose=j;
          if(watcher.kind==="psumValid"&&old!=="1"&&next==="1")c.psumRose=j;
        }
      }
      if(active && active.status!=="aborted"){
        for(const [blk,change]of changes){
          const b=blockOf(blk);if(!b)continue;
          if(change.psumRose!==undefined)b.recorded.psum_samples.push(sample(time,Math.max(change.psumRose,change.psum??-1),g.blocks[blk].psum,{bit:word(g.plane).value}));
          if(change.validRose!==undefined && !b.recorded.result){
            b.recorded.result=sample(time,Math.max(change.validRose,change.result??-1),g.blocks[blk].result);
            const expected=b.reference.dot.value,actual=b.recorded.result.word.value;
            b.recorded.comparison=expected===null||actual===null?null:expected===actual;
          }
        }
        if(active.completed_fs===null && active.blocks.length&&active.blocks.every(b=>b.recorded.result)){
          active.completed_fs=time;active.completed_event_index=Math.max(...active.blocks.map(b=>b.recorded.result.event_index));
          if(active.status==="running")active.status="result_ready";
        }
      }
      flushPending(time,j-1,changes);
      i=j;
    }
    if(pending.length)flushPending(trace.end_fs??previousTime,trace.events.length-1,null);
    return lessons;
  }

  function getLessonAt(lessons,timeFs,selectedId=null,eventCursor=Infinity){
    if(!Array.isArray(lessons)||!lessons.length)return {lesson:null,phase:"none",reference_is_future:false,recorded:[]};
    const started=t=>t.start_fs<=timeFs&&t.start_event_index<eventCursor;
    let lesson=selectedId===null?null:lessons.find(t=>t.id===selectedId);
    if(selectedId!==null&&!lesson)return {lesson:null,phase:"none",reference_is_future:false,recorded:[]};
    if(!lesson){
      let lo=0,hi=lessons.length;
      while(lo<hi){const mid=(lo+hi)>>1;if(started(lessons[mid]))lo=mid+1;else hi=mid;}
      lesson=lessons[Math.max(0,lo-1)];
    }
    const future=!started(lesson);
    const ended=lesson.end_fs!==null&&lesson.end_fs<=timeFs&&lesson.end_event_index<eventCursor;
    const ready=lesson.completed_fs!==null&&lesson.completed_fs<=timeFs&&lesson.completed_event_index<eventCursor;
    const phase=future?"future":ended?lesson.status:ready?"result_ready":"running";
    const recorded=lesson.blocks.map(b=>({blk:b.blk,
      result:!future&&visible(b.recorded.result,timeFs,eventCursor)?b.recorded.result:null,
      psum_samples:future?[]:b.recorded.psum_samples.filter(s=>visible(s,timeFs,eventCursor)),
      acc_samples:future?[]:b.recorded.acc_samples.filter(s=>visible(s,timeFs,eventCursor)),
      delivery_fs:!future&&b.recorded.delivery_fs!==null&&b.recorded.delivery_fs<=timeFs&&b.recorded.delivery_event_index<eventCursor?b.recorded.delivery_fs:null,
      comparison:!future&&visible(b.recorded.result,timeFs,eventCursor)?b.recorded.comparison:null}));
    return {lesson,phase,reference_is_future:future,recorded};
  }
  return {buildLessons,getLessonAt};
});
