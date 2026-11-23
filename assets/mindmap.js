/* ============ 通用 SVG 思维导图生成器（无外部依赖） ============
 * 用法：renderMindmap(svgElement, data, palette)
 * 数据结构：{ name:'中心', children:[{ name:'分支', children:[{name:'叶子'}, ...] }, ...] }
 * 横向树布局：中心在左，分支向右逐级展开，贝塞尔曲线连接。
 */
(function(global){
  const NS='http://www.w3.org/2000/svg';
  const LEVEL_GAP=200;   // 每层水平间距
  const V_GAP=16;        // 相邻叶子垂直间距
  const PAD_X=26, PAD_Y=24;

  function el(tag,attrs){const n=document.createElementNS(NS,tag);for(const k in attrs)n.setAttribute(k,attrs[k]);return n}
  function textWidth(str,fs){let w=0;for(const ch of str)w+=/[\u4e00-\u9fa5\uff00-\uffef]/.test(ch)?fs:fs*0.56;return w}

  function renderMindmap(svg,data,palette){
    const colors=palette||['#a78bfa','#f0a6d0','#7fd8e8','#ffd86b','#9be7a4','#ffa8a8'];
    let yCursor=PAD_Y;
    const nodes=[],links=[];

    // 返回 {node, y}；叶子按 yCursor 依次占位，父节点取首尾子节点中点
    function walk(raw,depth,branchColor){
      const isRoot=depth===0;
      // 根节点用主色，一级分支从调色板取色，更深层级继承分支色
      const color=isRoot?null:depth===1?branchColor:branchColor;
      const fs=isRoot?17:depth===1?14:12.5;
      const w=Math.max(isRoot?96:60,textWidth(raw.name,fs)+36);
      const h=isRoot?54:depth===1?40:34;
      const kids=(raw.children||[]).map((c,i)=>walk(c,depth+1,depth===0?colors[i%colors.length]:branchColor));

      let cy;
      if(kids.length){
        cy=(kids[0].y+kids[kids.length-1].y)/2;
      }else{
        cy=yCursor+h/2;
        yCursor+=h+V_GAP;
      }
      const node={name:raw.name,x:PAD_X+depth*LEVEL_GAP,y:cy-h/2,w:w,h:h,depth:depth,color:color,fs:fs};
      nodes.push(node);
      kids.forEach(k=>links.push({from:node,to:k.node,color:k.node.color}));
      return {node:node,y:cy};
    }

    walk(data,0,null);

    const maxX=Math.max(...nodes.map(n=>n.x+n.w))+PAD_X;
    const maxY=Math.max(yCursor,PAD_Y+120)+PAD_Y;
    svg.setAttribute('viewBox',`0 0 ${maxX} ${maxY}`);
    svg.setAttribute('width',maxX);
    svg.setAttribute('height',maxY);
    svg.innerHTML='';

    // 连线
    links.forEach(l=>{
      const x1=l.from.x+l.from.w, y1=l.from.y+l.from.h/2;
      const x2=l.to.x, y2=l.to.y+l.to.h/2;
      const mx=(x1+x2)/2;
      svg.appendChild(el('path',{
        d:`M ${x1} ${y1} C ${mx} ${y1}, ${mx} ${y2}, ${x2} ${y2}`,
        class:'mm-link',stroke:l.color||'rgba(255,255,255,.5)','stroke-opacity':.75
      }));
    });

    // 渐变定义
    const defs=el('defs',{});
    const grad=el('linearGradient',{id:'mmRootGrad',x1:'0',y1:'0',x2:'1',y2:'1'});
    grad.appendChild(el('stop',{offset:'0%','stop-color':'#a78bfa'}));
    grad.appendChild(el('stop',{offset:'100%','stop-color':'#f0a6d0'}));
    defs.appendChild(grad);svg.appendChild(defs);

    // 节点
    nodes.forEach(n=>{
      const g=el('g',{class:'mm-node'+(n.depth===0?' mm-root':'')});
      g.appendChild(el('rect',{
        x:n.x,y:n.y,width:n.w,height:n.h,rx:Math.min(n.h/2,14),ry:Math.min(n.h/2,14),
        class:'mm-rect',fill:n.depth===0?'url(#mmRootGrad)':(n.color||'#a78bfa'),'fill-opacity':n.depth===0?1:.94
      }));
      const t=el('text',{x:n.x+n.w/2,y:n.y+n.h/2,class:'mm-text','font-size':n.fs});
      t.textContent=n.name;
      g.appendChild(t);svg.appendChild(g);
    });
  }

  global.renderMindmap=renderMindmap;
})(window);
