import React, { useState, useEffect } from 'react';
import { useApp } from '../../store/AppContext';
import { loadFontFromArrayBuffer, textToGlyphContours, textToArcPolylines, getTextBounds } from '../../cam/textEngine';

const S = {
  form: { padding: '6px 8px', fontSize: 11 },
  row: { display: 'flex', alignItems: 'center', marginBottom: 5, gap: 4 },
  label: { color: '#8888aa', width: 120, flexShrink: 0, fontSize: 10, display: 'flex', alignItems: 'center', gap: 2 },
  input: { flex: 1, background: '#0d0d20', border: '1px solid #2a2a50', color: '#ccccee', borderRadius: 3, padding: '2px 5px', fontSize: 11, minWidth: 0 },
  select: { flex: 1, background: '#0d0d20', border: '1px solid #2a2a50', color: '#ccccee', borderRadius: 3, padding: '2px 4px', fontSize: 11 },
  check: { marginRight: 4 },
  section: { color: '#5555aa', fontSize: 9, textTransform: 'uppercase', letterSpacing: 1, marginTop: 8, marginBottom: 3, borderBottom: '1px solid #1a1a38', paddingBottom: 2 },
  unit: { color: '#555577', fontSize: 10, flexShrink: 0 },
};

function Tip({ text }) {
  const [pos, setPos] = React.useState(null);
  const ref = React.useRef();
  return (
    <span
      ref={ref}
      style={{ marginLeft: 2, color: '#444466', cursor: 'default', fontSize: 10, flexShrink: 0, lineHeight: 1 }}
      onMouseEnter={() => {
        const r = ref.current.getBoundingClientRect();
        setPos({ x: r.right + 6, y: r.top - 2 });
      }}
      onMouseLeave={() => setPos(null)}
    >
      ⓘ
      {pos && (
        <div style={{
          position: 'fixed',
          left: pos.x,
          top: pos.y,
          maxWidth: 260,
          background: '#1a1a38',
          border: '1px solid #3a3a60',
          color: '#ccccee',
          fontSize: 10,
          borderRadius: 4,
          padding: '6px 9px',
          zIndex: 9999,
          lineHeight: 1.5,
          pointerEvents: 'none',
          boxShadow: '0 2px 10px rgba(0,0,0,0.7)',
          whiteSpace: 'pre-wrap',
        }}>
          {text}
        </div>
      )}
    </span>
  );
}

function Field({ label, unit, tip, children }) {
  return (
    <div style={S.row}>
      <span style={S.label}>{label}{tip && <Tip text={tip} />}</span>
      {children}
      {unit && <span style={S.unit}>{unit}</span>}
    </div>
  );
}

function NumInput({ value, onChange, min, max, step = 0.1 }) {
  const [text, setText] = React.useState(value == null ? '' : String(value));
  const prevValue = React.useRef(value);

  if (prevValue.current !== value) {
    prevValue.current = value;
    setText(value == null ? '' : String(value));
  }

  return (
    <input
      type="number"
      style={S.input}
      value={text}
      min={min}
      max={max}
      step={step}
      onChange={e => {
        setText(e.target.value);
        const n = parseFloat(e.target.value);
        if (!isNaN(n)) onChange(n);
      }}
      onBlur={() => {
        if (isNaN(parseFloat(text))) setText(value == null ? '' : String(value));
      }}
    />
  );
}

function Sel({ value, onChange, options }) {
  return (
    <select style={S.select} value={value} onChange={e => onChange(e.target.value)}>
      {options.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
    </select>
  );
}

function CheckField({ label, value, onChange, tip }) {
  return (
    <div style={S.row}>
      <span style={S.label}>{label}{tip && <Tip text={tip} />}</span>
      <input type="checkbox" style={S.check} checked={value} onChange={e => onChange(e.target.checked)} />
    </div>
  );
}

const MM_PER_INCH = 25.4;
const PLUG_HEIGHT_OFFSET_MM = 25.4 * 0.075; // ≈ 1.905 mm (0.075 in default)

export default function OperationParams({ op, tools, operations = [], onChange }) {
  const { state, dispatch } = useApp();
  const isInch = state.postConfig?.units === 'inch';
  const p = op.params || {};

  // ── Text Engraving: font list state ────────────────────────────────────────
  const [fontList, setFontList] = useState([]);
  const [loadingFonts, setLoadingFonts] = useState(false);
  const [generatingGeometry, setGeneratingGeometry] = useState(false);

  useEffect(() => {
    if (op.type !== 'text' || fontList.length > 0 || loadingFonts) return;
    setLoadingFonts(true);
    window.electron?.listSystemFonts?.()
      .then(fonts => setFontList(fonts || []))
      .catch(() => {})
      .finally(() => setLoadingFonts(false));
  }, [op.type]); // load once when text op is first shown

  async function generateTextGeometry() {
    if (!p.fontPath || !p.text) return;
    setGeneratingGeometry(true);
    try {
      const fontBytes = await window.electron.readFontFile(p.fontPath);
      if (!fontBytes) { setGeneratingGeometry(false); return; }
      const ab = fontBytes.buffer.slice(fontBytes.byteOffset, fontBytes.byteOffset + fontBytes.byteLength);
      const font = loadFontFromArrayBuffer(ab);
      const capHeightMm = p.fontSize ?? 10; // always stored in mm via toMM()
      const glyphGroups = textToGlyphContours(font, p.text, capHeightMm);
      const bounds = getTextBounds(glyphGroups);
      const arcPolylines = textToArcPolylines(font, p.text, capHeightMm);
      onChange({ params: { ...p, textContoursRel: glyphGroups, textBoundsRel: bounds, textArcContoursRel: arcPolylines } });
    } catch (e) {
      console.error('Text geometry generation failed:', e);
    }
    setGeneratingGeometry(false);
  }

  function set(key, val) {
    onChange({ params: { ...p, [key]: val } });
  }

  function setName(name) {
    onChange({ name });
  }

  function toDisp(v) { return isInch ? +(v / MM_PER_INCH).toFixed(4) : v; }
  function toMM(v) { return isInch ? v * MM_PER_INCH : v; }
  const distUnit = isInch ? 'in' : 'mm';
  const feedUnit = isInch ? 'in/min' : 'mm/min';
  const dStep = isInch ? 0.01 : 0.1;
  const fStep = isInch ? 1 : 25;

  const commonDepth = (
    <>
      <div style={S.section}>Depth</div>
      <Field label="Total Depth" unit={distUnit} tip="Total cutting depth measured from Top of Stock downward. Entered as a positive number — the tool cuts downward by this amount.">
        <NumInput value={toDisp(p.totalDepth ?? 10)} onChange={v => set('totalDepth', toMM(v))} min={isInch ? 0.004 : 0.1} step={dStep} />
      </Field>
      <Field label="Top of Stock" unit={distUnit} tip="Z position of the workpiece surface. Usually 0. Raise this value if your stock sits above the table or spoilboard surface.">
        <NumInput value={toDisp(p.topZ ?? 0)} onChange={v => set('topZ', toMM(v))} step={isInch ? 0.02 : 0.5} />
      </Field>
      <Field label="Depth/Pass" unit={distUnit} tip="Maximum material removed per cutting pass. Shallower passes reduce tool load and heat. Typical: 0.5–1× tool diameter for roughing, 0.25× for finishing.">
        <NumInput value={toDisp(p.depthPerPass ?? 3)} onChange={v => set('depthPerPass', toMM(v))} min={isInch ? 0.001 : 0.01} step={dStep} />
      </Field>
      <Field label="Num Passes" tip="Calculated as Total Depth ÷ Depth/Pass. Edit this to distribute depth evenly — adjusts Depth/Pass automatically.">
        <NumInput value={Math.max(1, Math.ceil((p.totalDepth ?? 10) / (p.depthPerPass ?? 3)))} onChange={v => { const n = Math.max(1, Math.round(v)); set('depthPerPass', (p.totalDepth ?? 10) / n); }} min={1} step={1} />
      </Field>
    </>
  );

  const commonSpeeds = (
    <>
      <div style={S.section}>Feeds & Speeds</div>
      <Field label="Spindle RPM" unit="rpm" tip="Router spindle speed. Used to control VFD speed or relay on the Masso G3. Typical router bits: 15,000–24,000 RPM. Lower for larger bits or harder materials.">
        <NumInput value={p.spindleRpm || 18000} onChange={v => set('spindleRpm', v)} step={100} min={100} />
      </Field>
      <Field label="Feed Rate" unit={feedUnit} tip="XY cutting speed. Higher = faster cut but more tool stress and deflection. Consult feeds-and-speeds data for your material and bit diameter.">
        <NumInput value={toDisp(p.feedRate ?? 1500)} onChange={v => set('feedRate', toMM(v))} step={isInch ? 2 : 50} min={isInch ? 0.04 : 1} />
      </Field>
      <Field label="Plunge Rate" unit={feedUnit} tip="Z-axis entry speed. Keep lower than feed rate — plunging is harder on the bit. Typical: 25–40% of feed rate.">
        <NumInput value={toDisp(p.plungeRate ?? 500)} onChange={v => set('plungeRate', toMM(v))} step={fStep} min={isInch ? 0.04 : 1} />
      </Field>
      <Field label="Safe Z" unit={distUnit} tip="Clearance height for rapid moves between cuts. Must clear all clamps, fixtures, and raised areas on the workpiece. Typical: 10–25 mm above stock top.">
        <NumInput value={toDisp(p.safeZ ?? 25)} onChange={v => set('safeZ', toMM(v))} step={isInch ? 0.05 : 1} />
      </Field>
    </>
  );

  const commonDirection = (
    <Field label="Direction" tip="Climb: tool moves in the same direction as spindle rotation — smoother finish, less heat, preferred for CNC routers.\nConventional: tool moves against rotation — useful for some harder materials or where climb isn't possible.\nBoth: alternates climb and conventional on successive passes — reduces air travel and machining time.">
      <Sel value={p.climb === false ? 'conventional' : p.climb === 'both' ? 'both' : 'climb'}
           onChange={v => set('climb', v === 'climb' ? true : v === 'conventional' ? false : 'both')}
           options={[['climb','Climb'],['conventional','Conventional'],['both','Both']]} />
    </Field>
  );

  const hasBoundary = !!(p.boundaryIds?.length);
  const nSel = state.selectedEntityIds?.length ?? 0;
  const boundarySection = p.cutSide === 'outside' ? (
    <>
      <div style={S.section}>Boundary</div>
      <Field label="Clip to">
        <span style={{ ...S.input, color: hasBoundary ? '#88ff88' : '#888888', fontSize: 10, display: 'flex', alignItems: 'center' }}>
          {hasBoundary ? `${p.boundaryIds.length} entit${p.boundaryIds.length === 1 ? 'y' : 'ies'}` : 'Stock rectangle'}
        </span>
      </Field>
      <Field label="">
        {nSel > 0
          ? <button style={{ ...S.input, cursor: 'pointer', textAlign: 'center' }}
                    onClick={() => set('boundaryIds', [...state.selectedEntityIds])}>
              Use {nSel} selected
            </button>
          : <button style={{ ...S.input, cursor: 'pointer', textAlign: 'center', color: hasBoundary ? '#ff8888' : '#555577' }}
                    onClick={() => set('boundaryIds', null)}
                    disabled={!hasBoundary}>
              {hasBoundary ? 'Clear (use stock)' : 'Select entities first'}
            </button>
        }
      </Field>
    </>
  ) : null;

  const toolSelect = (
    <>
      <div style={S.section}>Tool</div>
      <Field label="Tool" tip="Select from your Tool Library to auto-fill diameter and type, or choose 'Manual diameter' to enter it directly below.">
        <select style={S.select} value={op.toolId || ''} onChange={e => {
          const toolId = e.target.value || null;
          const tool = toolId ? tools.find(t => t.id === toolId) : null;
          const feed = tool?.feeds?.[0];
          const updates = { toolId };
          if (feed?.stepover != null) updates.params = { ...p, stepover: feed.stepover };
          onChange(updates);
        }}>
          <option value="">Manual diameter...</option>
          {tools.map(t => (
            <option key={t.id} value={t.id}>
              {t.name} (⌀{isInch ? (t.diameter / MM_PER_INCH).toFixed(4) : t.diameter}{distUnit})
            </option>
          ))}
        </select>
      </Field>
      {!op.toolId && (
        <Field label="Tool Diameter" unit={distUnit} tip="Cutting diameter of the end mill. Used to compute path offset, stepover width, and lead-in geometry.">
          <NumInput value={toDisp(p.toolDiameter ?? 6.35)} onChange={v => set('toolDiameter', toMM(v))} min={isInch ? 0.004 : 0.1} step={isInch ? 0.001 : 0.01} />
        </Field>
      )}
    </>
  );

  return (
    <div style={S.form}>
      <Field label="Name" tip="Label for this operation; appears in the operations list and G-code header comments.">
        <input style={S.input} type="text" value={op.name} onChange={e => setName(e.target.value)} />
      </Field>

      {/* ── Contour ── */}
      {op.type === 'contour' && <>
        {toolSelect}
        <div style={S.section}>Compensation</div>
        <Field label="Cut Side" tip="Outside: tool offsets outside the profile, cutting a perimeter or edge.\nInside: tool offsets inside, cutting a slot or groove.\nCenter: no offset — tool center follows the line exactly.">
          <Sel value={p.cutSide || 'outside'} onChange={v => set('cutSide', v)} options={[['outside','Outside'],['inside','Inside'],['center','Center line']]} />
        </Field>
        <Field label="Stock to Leave" unit={distUnit} tip="Radial material left on the wall after this pass. Use 0.2–0.5 mm for a roughing pass, then finish with 0. Positive value = leaves material; 0 = cuts to final size.">
          <NumInput value={toDisp(p.stockToLeave ?? 0)} onChange={v => set('stockToLeave', toMM(v))} step={isInch ? 0.002 : 0.05} />
        </Field>
        {commonDirection}
        {commonDepth}
        <div style={S.section}>Lead-in</div>
        <Field label="Style" tip="How the tool first enters the cut.\nPlunge: straight down.\nRamp: angled descent along the path, reduces plunge stress.\nTangential Arc: smooth curved entry from outside — best for finish passes.">
          <Sel value={p.leadInStyle ?? (p.rampEntry ? 'ramp' : 'plunge')} onChange={v => set('leadInStyle', v)} options={[['plunge','Plunge'],['ramp','Ramp'],['arc','Tangential Arc']]} />
        </Field>
        {(p.leadInStyle ?? (p.rampEntry ? 'ramp' : 'plunge')) === 'ramp' && (
          <Field label="Ramp Angle" unit="°" tip="Slope angle of the ramp entry. Lower is gentler on the tool. Typical: 1–5°. Steeper angles shorten the ramp distance.">
            <NumInput value={p.rampAngle || 3} onChange={v => set('rampAngle', v)} min={0.5} max={30} />
          </Field>
        )}
        {(p.leadInStyle ?? (p.rampEntry ? 'ramp' : 'plunge')) === 'arc' && (
          <Field label="Arc Radius" unit={distUnit} tip="Radius of the tangential arc lead-in. Typically 50–100% of tool radius. Smaller radius = tighter entry curve.">
            <NumInput value={toDisp(p.leadInArcRadius ?? (p.toolDiameter || 6.35) / 2)} onChange={v => set('leadInArcRadius', toMM(v))} min={isInch ? 0.01 : 0.25} step={dStep} />
          </Field>
        )}
        <div style={S.section}>Tabs</div>
        <CheckField label="Hold-down Tabs" value={p.tabs} onChange={v => set('tabs', v)} tip="Thin material bridges left at the bottom of the cut to keep the part attached to the stock. Remove by hand after cutting is complete." />
        {p.tabs && <>
          <Field label="Tab Width" unit={distUnit} tip="Length of each tab along the toolpath. Wider tabs hold better but are harder to remove. Typical: 4–8 mm.">
            <NumInput value={toDisp(p.tabWidth ?? 6)} onChange={v => set('tabWidth', toMM(v))} min={isInch ? 0.04 : 1} step={dStep} />
          </Field>
          <Field label="Tab Height" unit={distUnit} tip="Height of the tab measured from the bottom of the cut. Must be less than Total Depth. Typical: 1–2 mm.">
            <NumInput value={toDisp(p.tabHeight ?? 1.5)} onChange={v => set('tabHeight', toMM(v))} min={isInch ? 0.005 : 0.1} step={dStep} />
          </Field>
          <Field label="Profile" tip="Cross-section shape of each tab.\nFlat: constant height.\nDMD Curve: gradual wave profile, smoother tool entry/exit.\nTriangle: sharp peak — easiest to snap off.">
            <Sel value={p.tabProfile || 'flat'} onChange={v => set('tabProfile', v)} options={[['flat','Flat'],['dmd','DMD Curve'],['triangle','Triangle']]} />
          </Field>
          <Field label="Placement" tip="Auto: distributes tabs evenly around the path.\nManual: click directly on the canvas to place each tab after calculating the toolpath.">
            <Sel value={p.tabMode || 'auto'} onChange={v => set('tabMode', v)} options={[['auto','Automatic'],['manual','Manual']]} />
          </Field>
          {(p.tabMode || 'auto') === 'auto' && (
            <Field label="Tab Count" tip="Number of tabs evenly spaced around the profile. More tabs = more secure part. Typical: 2 for small parts, 4–6 for larger profiles.">
              <NumInput value={p.tabCount || 4} onChange={v => set('tabCount', v)} step={1} min={2} max={12} />
            </Field>
          )}
          {p.tabMode === 'manual' && (() => {
            const placed = (p.tabPositions || []).length;
            const isActive = state.tabPlacementActive && state.tabPlacementOpId === op.id;
            const noContour = !op.toolpath?.contours?.length;
            return <>
              <div style={S.row}>
                <span style={S.label}>Tabs placed</span>
                <span style={{ color: placed > 0 ? '#88ffaa' : '#666688', fontSize: 11 }}>{placed}</span>
              </div>
              {noContour && (
                <div style={{ ...S.row, color: '#aa8844', fontSize: 10, paddingLeft: 4 }}>
                  Calculate toolpath first to enable placement
                </div>
              )}
              <Field label="">
                <button
                  disabled={noContour}
                  style={{ ...S.input, cursor: noContour ? 'default' : 'pointer', textAlign: 'center', opacity: noContour ? 0.4 : 1,
                    background: isActive ? '#2a1040' : '#0d0d20',
                    borderColor: isActive ? '#9944ff' : '#2a2a50',
                    color: isActive ? '#cc88ff' : '#ccccee' }}
                  onClick={() => dispatch({ type: 'SET_TAB_PLACEMENT', payload: { active: !isActive, opId: isActive ? null : op.id } })}>
                  {isActive ? 'Done Placing' : 'Place on Canvas'}
                </button>
              </Field>
              {placed > 0 && (
                <Field label="">
                  <button style={{ ...S.input, cursor: 'pointer', textAlign: 'center', color: '#ff8888' }}
                    onClick={() => dispatch({ type: 'UPDATE_TAB_POSITIONS', payload: { opId: op.id, positions: [] } })}>
                    Clear All Tabs
                  </button>
                </Field>
              )}
            </>;
          })()}
        </>}
        <div style={S.section}>Finish</div>
        <CheckField label="Finish Pass" value={p.finishPass} onChange={v => set('finishPass', v)} tip="Adds a final light radial pass at full depth after the main cut to improve wall surface finish." />
        <CheckField label="Keep Down" value={p.keepDown} onChange={v => set('keepDown', v)} tip="Skip safe-Z retracts between depth passes — tool plunges directly to next depth without lifting. Only enable for simple closed profiles with no obstacles between passes." />
        {commonSpeeds}
      </>}

      {/* ── Pocket ── */}
      {op.type === 'pocket' && <>
        {toolSelect}
        <div style={S.section}>Clearing</div>
        <Field label="Cut Side" tip="Inside (Pocket): clears all material inside the closed profile.\nOutside (Boss): clears material outside the profile, leaving a raised island.">
          <Sel value={p.cutSide || 'inside'} onChange={v => set('cutSide', v)} options={[['inside','Inside (pocket)'],['outside','Outside (boss)']]} />
        </Field>
        {boundarySection}
        <Field label="Max Stepover %" tip="Maximum radial step between passes as a % of tool diameter. Caps the tool library's stepover — whichever is lower wins. Lower = smoother floor, more passes.\nRoughing: 30–50%. Finishing: 10–20%.">
          <NumInput value={Math.round((p.stepover || 0.45) * 100)} onChange={v => set('stepover', v / 100)} step={5} min={5} max={95} />
        </Field>
        <CheckField label="Start from Center" value={p.startFromCenter} onChange={v => set('startFromCenter', v)} tip="Begin the spiral toolpath at the center and expand outward. Gives a cleaner first engagement and avoids rubbing on the initial pass." />
        <CheckField label="Keep Down" value={p.keepDown} onChange={v => set('keepDown', v)} tip="Skip retracts between clearing passes — tool stays at cutting depth. Always safe for simple pockets with no islands. For pockets with islands, use with care: the tool travels at floor level and may collide with island walls." />
        <div style={S.section}>Rest Machining</div>
        <CheckField label="Rest Machining" value={!!p.restMachining} onChange={v => set('restMachining', v)} tip="Only cuts areas a previous larger tool couldn't reach. Enable this when following a roughing pass with a smaller finishing bit." />
        {p.restMachining && <Field label="Prev Tool Dia" unit={distUnit} tip="Diameter of the previous (larger) tool whose leftover material this pass will clean up.">
          <NumInput value={toDisp(p.previousToolDiameter ?? 12.7)} onChange={v => set('previousToolDiameter', toMM(v))} min={isInch ? 0.004 : 0.1} step={isInch ? 0.001 : 0.01} />
        </Field>}
        {commonDirection}
        {commonDepth}
        <div style={S.section}>Lead-in</div>
        <Field label="Style" tip="How the tool first enters the pocket.\nPlunge: straight down.\nRamp: angled entry along the path.\nHelical: spiral descent — gentlest entry, best for pockets in solid material.">
          <Sel value={p.leadInStyle || 'plunge'} onChange={v => set('leadInStyle', v)} options={[['plunge','Plunge'],['ramp','Ramp'],['helical','Helical']]} />
        </Field>
        {(p.leadInStyle || 'plunge') === 'ramp' && (
          <Field label="Ramp Angle" unit="°" tip="Slope angle of the ramp entry. Lower is gentler on the tool. Typical: 1–5°.">
            <NumInput value={p.rampAngle || 3} onChange={v => set('rampAngle', v)} min={0.5} max={30} />
          </Field>
        )}
        {(p.leadInStyle || 'plunge') === 'helical' && (
          <Field label="Helix Radius" unit={distUnit} tip="Radius of the helical entry spiral. Must fit inside the pocket. Typical: 20–40% of tool diameter.">
            <NumInput value={toDisp(p.leadInArcRadius ?? (p.toolDiameter || 6.35) / 4)} onChange={v => set('leadInArcRadius', toMM(v))} min={isInch ? 0.01 : 0.25} step={dStep} />
          </Field>
        )}
        <div style={S.section}>Finish</div>
        <CheckField label="Finish Pass" value={p.finishPass} onChange={v => set('finishPass', v)} tip="Adds a final light pass around the pocket walls at full depth to improve surface finish and hit exact dimensions." />
        {p.finishPass && <Field label="Finish Allowance" unit={distUnit} tip="Radial stock left by the roughing passes for the finish pass to remove. Typical: 0.1–0.5 mm.">
          <NumInput value={toDisp(p.finishAllowance ?? 0.2)} onChange={v => set('finishAllowance', toMM(v))} step={isInch ? 0.002 : 0.05} />
        </Field>}
        {commonSpeeds}
      </>}

      {/* ── Adaptive ── */}
      {op.type === 'adaptive' && <>
        {toolSelect}
        <div style={S.section}>Clearing</div>
        <Field label="Cut Side" tip="Inside (Pocket): clears material inside the profile.\nOutside (Boss): clears material outside, leaving a raised island.">
          <Sel value={p.cutSide || 'inside'} onChange={v => set('cutSide', v)} options={[['inside','Inside (pocket)'],['outside','Outside (boss)']]} />
        </Field>
        {boundarySection}
        <Field label="Max Stepover %" tip="Maximum radial step between passes as a % of tool diameter. Caps the tool library's stepover — whichever is lower wins. Adaptive paths maintain a more constant chip load — lower values give a lighter, faster cut.\nTypical: 20–40%.">
          <NumInput value={Math.round((p.stepover || 0.35) * 100)} onChange={v => set('stepover', v / 100)} step={5} min={5} max={60} />
        </Field>
        <Field label="Optimal Load %" tip="Target chip load as a fraction of tool diameter. Lower = lighter constant-engagement cut, allowing a higher feed rate. Typical: 20–35%.">
          <NumInput value={Math.round((p.optimalLoad || 0.3) * 100)} onChange={v => set('optimalLoad', v / 100)} step={5} min={5} max={50} />
        </Field>
        <div style={S.section}>Rest Machining</div>
        <CheckField label="Rest Machining" value={!!p.restMachining} onChange={v => set('restMachining', v)} tip="Only cuts areas a previous larger tool couldn't reach. Enable when following a roughing pass with a smaller bit." />
        {p.restMachining && <Field label="Prev Tool Dia" unit={distUnit} tip="Diameter of the previous (larger) tool whose leftover material this pass will clean up.">
          <NumInput value={toDisp(p.previousToolDiameter ?? 12.7)} onChange={v => set('previousToolDiameter', toMM(v))} min={isInch ? 0.004 : 0.1} step={isInch ? 0.001 : 0.01} />
        </Field>}
        {commonDirection}
        {commonDepth}
        <div style={S.section}>Lead-in</div>
        <Field label="Style" tip="How the tool first enters the cut.\nPlunge: straight down.\nRamp: angled descent.\nHelical: spiral descent — gentlest entry, best for solid material.">
          <Sel value={p.leadInStyle || 'ramp'} onChange={v => set('leadInStyle', v)} options={[['plunge','Plunge'],['ramp','Ramp'],['helical','Helical']]} />
        </Field>
        {(p.leadInStyle || 'ramp') === 'ramp' && (
          <Field label="Ramp Angle" unit="°" tip="Slope angle of the ramp entry. Lower is gentler on the tool. Typical: 1–5°.">
            <NumInput value={p.rampAngle || 2} onChange={v => set('rampAngle', v)} min={0.5} max={15} />
          </Field>
        )}
        {(p.leadInStyle || 'ramp') === 'helical' && (
          <Field label="Helix Radius" unit={distUnit} tip="Radius of the helical entry spiral. Must fit inside the pocket. Typical: 20–40% of tool diameter.">
            <NumInput value={toDisp(p.leadInArcRadius ?? (p.toolDiameter || 6.35) / 4)} onChange={v => set('leadInArcRadius', toMM(v))} min={isInch ? 0.01 : 0.25} step={dStep} />
          </Field>
        )}
        {commonSpeeds}
      </>}

      {/* ── Face ── */}
      {op.type === 'face' && <>
        {toolSelect}
        <div style={S.section}>Pass</div>
        <Field label="Max Stepover %" tip="Maximum overlap between adjacent facing passes as a % of tool diameter. Caps the tool library's stepover — whichever is lower wins. Typical: 60–80%. Use a surfacing bit for best results.">
          <NumInput value={Math.round((p.stepover || 0.75) * 100)} onChange={v => set('stepover', v / 100)} step={5} min={10} max={95} />
        </Field>
        <Field label="Angle" unit="°" tip="Direction of facing passes in degrees from the X axis. 0 = along X, 90 = along Y. A 45° angle can reduce visible parallel-line patterns on the surface.">
          <NumInput value={p.angle ?? 0} onChange={v => set('angle', v)} step={5} />
        </Field>
        <Field label="Stock Top" unit={distUnit} tip="Z position of the top surface being faced. Usually 0.">
          <NumInput value={toDisp(p.topZ ?? 0)} onChange={v => set('topZ', toMM(v))} step={isInch ? 0.02 : 0.5} />
        </Field>
        <Field label="Total Depth" unit={distUnit} tip="Total material to remove from the top surface (e.g. facing allowance). Typical: 0.5–2 mm.">
          <NumInput value={toDisp(p.totalDepth ?? 3)} onChange={v => set('totalDepth', toMM(v))} min={isInch ? 0.004 : 0.1} step={dStep} />
        </Field>
        <Field label="Depth/Pass" unit={distUnit} tip="Material removed per pass. Facing operations often use a single light pass. Typical: 0.5–1 mm.">
          <NumInput value={toDisp(p.depthPerPass ?? 1)} onChange={v => set('depthPerPass', toMM(v))} min={isInch ? 0.001 : 0.1} step={dStep} />
        </Field>
        <Field label="Num Passes" tip="Calculated as Total Depth ÷ Depth/Pass. Edit to adjust depth per pass proportionally.">
          <NumInput value={Math.max(1, Math.ceil((p.totalDepth ?? 3) / (p.depthPerPass ?? 1)))} onChange={v => { const n = Math.max(1, Math.round(v)); set('depthPerPass', (p.totalDepth ?? 3) / n); }} min={1} step={1} />
        </Field>
        <div style={S.section}>Extension</div>
        <Field label="X+/-" unit={distUnit} tip="Extra overshoot past the stock edges in the X direction. Ensures the cutter fully clears the part boundary on both sides.">
          <NumInput value={toDisp(p.stockLeft ?? 2)} onChange={v => set('stockLeft', toMM(v))} step={dStep} />
        </Field>
        <Field label="Y+/-" unit={distUnit} tip="Extra overshoot past the stock edges in the Y direction.">
          <NumInput value={toDisp(p.stockFront ?? 2)} onChange={v => set('stockFront', toMM(v))} step={dStep} />
        </Field>
        <div style={S.section}>Lead-in</div>
        <Field label="Style" tip="How the tool first enters the pass.\nPlunge: straight down at the start.\nRamp: angled entry — reduces tool stress.">
          <Sel value={p.leadInStyle || 'plunge'} onChange={v => set('leadInStyle', v)} options={[['plunge','Plunge'],['ramp','Ramp']]} />
        </Field>
        {(p.leadInStyle || 'plunge') === 'ramp' && (
          <Field label="Ramp Angle" unit="°" tip="Slope angle of the ramp entry. Typical: 1–5°.">
            <NumInput value={p.rampAngle || 3} onChange={v => set('rampAngle', v)} min={0.5} max={30} />
          </Field>
        )}
        {commonSpeeds}
      </>}

      {/* ── Drill ── */}
      {op.type === 'drill' && <>
        <div style={S.section}>Depth</div>
        <Field label="Total Depth" unit={distUnit} tip="Total drilling depth measured from Top of Stock downward.">
          <NumInput value={toDisp(p.totalDepth ?? 20)} onChange={v => set('totalDepth', toMM(v))} step={dStep} />
        </Field>
        <Field label="Top of Stock" unit={distUnit} tip="Z position of the workpiece surface. Usually 0.">
          <NumInput value={toDisp(p.topZ ?? 0)} onChange={v => set('topZ', toMM(v))} step={isInch ? 0.02 : 0.5} />
        </Field>
        <Field label="Safe Z" unit={distUnit} tip="Clearance height for rapid moves between drill points. Must clear all clamps and raised areas. Typical: 10–25 mm.">
          <NumInput value={toDisp(p.safeZ ?? 25)} onChange={v => set('safeZ', toMM(v))} step={isInch ? 0.05 : 1} />
        </Field>
        <div style={S.section}>Peck</div>
        <Field label="Peck Depth" unit={distUnit} tip="How deep to drill before retracting to clear chips. 0 = full-depth plunge (no pecking). Use pecking for deep holes or materials that pack chips. Typical: 1–3× drill diameter.">
          <NumInput value={toDisp(p.peckDepth ?? 0)} onChange={v => set('peckDepth', toMM(v))} step={dStep} />
        </Field>
        <CheckField label="Chip Break Only" value={p.chipBreak} onChange={v => set('chipBreak', v)} tip="Retract only slightly between pecks (chip break) instead of a full retract. Faster than full pecking; suitable when chip packing isn't a concern." />
        <div style={S.section}>Feeds & Speeds</div>
        <Field label="Spindle RPM" unit="rpm" tip="Drill spindle speed. Lower than milling — typically 1,000–6,000 RPM depending on drill diameter and material.">
          <NumInput value={p.spindleRpm || 3000} onChange={v => set('spindleRpm', v)} step={100} />
        </Field>
        <Field label="Drill Rate" unit={feedUnit} tip="Feed rate for the drilling plunge. Depends on drill diameter and material. Typically slower than end-milling feed rates.">
          <NumInput value={toDisp(p.feedRate ?? 300)} onChange={v => set('feedRate', toMM(v))} step={fStep} />
        </Field>
        <Field label="Dwell (bottom)" unit="s" tip="Pause time in seconds at the bottom of the hole. Helps clean the hole bottom in some materials. 0 = no dwell.">
          <NumInput value={p.dwellTime ?? 0} onChange={v => set('dwellTime', v)} step={0.1} />
        </Field>
      </>}

      {/* ── Bore ── */}
      {op.type === 'bore' && <>
        {toolSelect}
        <div style={S.section}>Bore</div>
        <Field label="Total Depth" unit={distUnit} tip="Total bore depth measured from Top of Stock downward.">
          <NumInput value={toDisp(p.totalDepth ?? 20)} onChange={v => set('totalDepth', toMM(v))} step={dStep} />
        </Field>
        <Field label="Top of Stock" unit={distUnit} tip="Z position of the workpiece surface. Usually 0.">
          <NumInput value={toDisp(p.topZ ?? 0)} onChange={v => set('topZ', toMM(v))} step={isInch ? 0.02 : 0.5} />
        </Field>
        <Field label="Helix Pitch" unit={distUnit} tip="Vertical drop per full revolution of the helical bore path. Smaller pitch = more revolutions per mm of depth, smoother bore wall. Typical: 0.5–2 mm.">
          <NumInput value={toDisp(p.helicalPitch ?? 1.5)} onChange={v => set('helicalPitch', toMM(v))} step={isInch ? 0.01 : 0.25} min={isInch ? 0.004 : 0.1} />
        </Field>
        <Field label="Direction" tip="Climb (CCW helix): typically produces a smoother bore wall finish.\nConventional (CW helix): more conservative engagement.">
          <Sel value={p.direction || 'climb'} onChange={v => set('direction', v)} options={[['climb','Climb (CCW)'],['conventional','Conventional (CW)']]} />
        </Field>
        {commonSpeeds}
      </>}

      {/* ── Circular ── */}
      {op.type === 'circular' && <>
        {toolSelect}
        <Field label="Max Stepover %" tip="Maximum radial step between concentric circular passes as a % of tool diameter. Caps the tool library's stepover — whichever is lower wins. Lower = smoother pocket floor. Typical: 30–50%.">
          <NumInput value={Math.round((p.stepover || 0.4) * 100)} onChange={v => set('stepover', v / 100)} step={5} />
        </Field>
        <Field label="Lead-in" tip="Plunge: straight down at entry.\nHelical: spiral descent into the circular pocket — gentler on the tool.">
          <Sel value={p.leadInStyle ?? (p.helicalEntry !== false ? 'ramp' : 'plunge')} onChange={v => set('leadInStyle', v)} options={[['plunge','Plunge'],['ramp','Helical']]} />
        </Field>
        {commonDirection}
        <div style={S.section}>Rest Machining</div>
        <CheckField label="Rest Machining" value={!!p.restMachining} onChange={v => set('restMachining', v)} tip="Only cuts areas a previous larger tool couldn't reach. Enable when following a roughing pass with a smaller bit." />
        {p.restMachining && <Field label="Prev Tool Dia" unit={distUnit} tip="Diameter of the previous (larger) tool whose leftover material this pass will clean up.">
          <NumInput value={toDisp(p.previousToolDiameter ?? 12.7)} onChange={v => set('previousToolDiameter', toMM(v))} min={isInch ? 0.004 : 0.1} step={isInch ? 0.001 : 0.01} />
        </Field>}
        {commonDepth}
        {commonSpeeds}
      </>}

      {/* ── Engrave / Trace ── */}
      {(op.type === 'engrave' || op.type === 'trace') && <>
        <div style={S.section}>Depth</div>
        <Field label="Depth" unit={distUnit} tip="Engraving depth below the stock surface. Shallower = finer detail with a V-bit (groove widens with depth). Typical: 0.2–2 mm.">
          <NumInput value={toDisp(p.depth ?? 1.5)} onChange={v => set('depth', toMM(v))} step={dStep} min={isInch ? 0.001 : 0.01} />
        </Field>
        <Field label="Top of Stock" unit={distUnit} tip="Z position of the workpiece surface. Usually 0.">
          <NumInput value={toDisp(p.topZ ?? 0)} onChange={v => set('topZ', toMM(v))} step={isInch ? 0.02 : 0.5} />
        </Field>
        <Field label="Safe Z" unit={distUnit} tip="Clearance height for rapid moves between engraved segments. Typical: 5–15 mm above stock top.">
          <NumInput value={toDisp(p.safeZ ?? 25)} onChange={v => set('safeZ', toMM(v))} step={isInch ? 0.05 : 1} />
        </Field>
        {commonDirection}
        <div style={S.section}>Feeds & Speeds</div>
        <Field label="Spindle RPM" unit="rpm" tip="Spindle speed for engraving. Typically high RPM with low feed for fine detail. Typical: 18,000–24,000 RPM.">
          <NumInput value={p.spindleRpm || 18000} onChange={v => set('spindleRpm', v)} step={100} />
        </Field>
        <Field label="Feed Rate" unit={feedUnit} tip="XY cutting speed for engraving passes. Lower than standard milling — typically 500–1,500 mm/min for detail work.">
          <NumInput value={toDisp(p.feedRate ?? 800)} onChange={v => set('feedRate', toMM(v))} step={isInch ? 2 : 50} />
        </Field>
        <Field label="Plunge Rate" unit={feedUnit} tip="Z-axis entry speed. Keep conservative for V-bits. Typical: 25–50% of feed rate.">
          <NumInput value={toDisp(p.plungeRate ?? 300)} onChange={v => set('plungeRate', toMM(v))} step={fStep} />
        </Field>
      </>}

      {/* ── Slot ── */}
      {op.type === 'slot' && <>
        {toolSelect}
        <CheckField label="Ramp Entry" value={p.rampEntry} onChange={v => set('rampEntry', v)} tip="Angled entry into the slot instead of a straight plunge. Reduces tool stress and tip wear. Recommended for slots cut in a single pass." />
        {p.rampEntry && <Field label="Ramp Angle" unit="°" tip="Slope angle of the ramp entry. Lower is gentler. Typical: 1–5°.">
          <NumInput value={p.rampAngle || 3} onChange={v => set('rampAngle', v)} min={0.5} max={30} />
        </Field>}
        {commonDirection}
        {commonDepth}
        {commonSpeeds}
      </>}

      {/* ── Chamfer ── */}
      {op.type === 'chamfer' && <>
        {toolSelect}
        <div style={S.section}>Chamfer</div>
        <Field label="Cut Side" tip="Outside edge: chamfers the top outer edge of a contour.\nInside edge: chamfers the inside of a pocket or opening.">
          <Sel value={p.cutSide || 'outside'} onChange={v => set('cutSide', v)} options={[['outside','Outside edge'],['inside','Inside edge']]} />
        </Field>
        <Field label="Chamfer Angle" unit="°" tip="Angle of the chamfer face from horizontal. Must match your actual V-bit included angle (e.g. a 90° bit = 45° half angle). Typical: 45°.">
          <NumInput value={p.chamferAngle || 45} onChange={v => set('chamferAngle', v)} step={5} min={10} max={80} />
        </Field>
        <Field label="Chamfer Width" unit={distUnit} tip="Width of the chamfer face on the top surface. Wider chamfer = deeper V-bit engagement. Typical: 0.5–2 mm.">
          <NumInput value={toDisp(p.chamferWidth ?? 1.0)} onChange={v => set('chamferWidth', toMM(v))} step={isInch ? 0.005 : 0.1} min={isInch ? 0.004 : 0.1} />
        </Field>
        <Field label="Top Z" unit={distUnit} tip="Z position of the stock surface being chamfered. Adjust if chamfering a face that isn't at Z=0.">
          <NumInput value={toDisp(p.topZ ?? 0)} onChange={v => set('topZ', toMM(v))} step={isInch ? 0.02 : 0.5} />
        </Field>
        <Field label="Safe Z" unit={distUnit} tip="Clearance height for rapid moves between chamfer passes. Typical: 10–25 mm.">
          <NumInput value={toDisp(p.safeZ ?? 25)} onChange={v => set('safeZ', toMM(v))} step={isInch ? 0.05 : 1} />
        </Field>
        {commonDirection}
        {commonSpeeds}
      </>}

      {/* ── Thread ── */}
      {op.type === 'thread' && <>
        {toolSelect}
        <div style={S.section}>Thread</div>
        <Field label="Thread Pitch" unit={distUnit} tip="Distance between adjacent thread peaks. Must match the thread standard exactly.\nExamples: M6×1.0, M8×1.25, 1/4-20 UNC ≈ 1.27 mm, 1/4-28 UNF ≈ 0.91 mm.">
          <NumInput value={toDisp(p.pitch ?? 1.25)} onChange={v => set('pitch', toMM(v))} step={isInch ? 0.005 : 0.25} min={isInch ? 0.004 : 0.1} />
        </Field>
        <Field label="Total Depth" unit={distUnit} tip="Total thread depth measured from Top of Stock downward. For through-threads, set to material thickness.">
          <NumInput value={toDisp(p.totalDepth ?? 15)} onChange={v => set('totalDepth', toMM(v))} step={dStep} />
        </Field>
        <Field label="Top Z" unit={distUnit} tip="Z position of the stock surface where threading begins. Usually 0.">
          <NumInput value={toDisp(p.topZ ?? 0)} onChange={v => set('topZ', toMM(v))} step={isInch ? 0.02 : 0.5} />
        </Field>
        <Field label="Direction" tip="Right-hand: thread tightens clockwise (standard for most fasteners).\nLeft-hand: thread tightens counter-clockwise (reverse/specialty applications).">
          <Sel value={p.direction || 'right'} onChange={v => set('direction', v)} options={[['right','Right-hand'],['left','Left-hand']]} />
        </Field>
        <Field label="Type" tip="Internal: threads the inside of a hole (like a nut or tapped hole).\nExternal: threads the outside of a cylinder (like a bolt or stud).">
          <Sel value={p.internal ? 'internal' : 'external'} onChange={v => set('internal', v === 'internal')} options={[['internal','Internal'],['external','External']]} />
        </Field>
        <div style={S.section}>Feeds & Speeds</div>
        <Field label="Spindle RPM" unit="rpm" tip="Thread milling spindle speed. Typically lower than standard milling. Consult your thread mill manufacturer's data.">
          <NumInput value={p.spindleRpm || 1000} onChange={v => set('spindleRpm', v)} step={100} />
        </Field>
        <Field label="Feed Rate" unit={feedUnit} tip="XY feed rate for the helical thread path. Calculated as RPM × pitch × number of starts for single-point thread mills.">
          <NumInput value={toDisp(p.feedRate ?? 400)} onChange={v => set('feedRate', toMM(v))} step={fStep} />
        </Field>
        <Field label="Safe Z" unit={distUnit} tip="Clearance height for rapid moves between thread locations. Typical: 10–25 mm.">
          <NumInput value={toDisp(p.safeZ ?? 25)} onChange={v => set('safeZ', toMM(v))} step={isInch ? 0.05 : 1} />
        </Field>
      </>}

      {/* ── Tapered Pocket / Tapered Plug ── */}
      {(op.type === 'taperedpocket' || op.type === 'taperedplug') && (() => {
        const isPlug       = op.type === 'taperedplug';
        const passes       = p.passes || {};
        const tc = passes.taperContour  || {};
        const tk = passes.taperCleanup  || {};
        const de = passes.detailEndmill || {};
        const be = passes.bulkEndmill   || {};

        const taperTools   = tools.filter(t => ['tapered','engraving'].includes(t.type));
        const endmillTools = tools.filter(t => ['flat','upcut','downcut','compression'].includes(t.type));

        function setPass(key, field, val) {
          const cur = passes[key] || {};
          onChange({ params: { ...p, passes: { ...passes, [key]: { ...cur, [field]: val } } } });
        }

        function selectTaperPass(key, e) {
          const id   = e.target.value || null;
          const tool = id ? tools.find(t => String(t.id) === id) : null;
          const cur  = passes[key] || {};
          const upd  = { ...cur, toolId: id };
          if (tool?.tipDiameter != null) upd.tipDia = tool.tipDiameter;
          if (tool?.taperAngle  != null) upd.angle  = tool.taperAngle;
          onChange({ params: { ...p, passes: { ...passes, [key]: upd } } });
        }

        function selectEndmillPass(key, e) {
          const id   = e.target.value || null;
          const tool = id ? tools.find(t => String(t.id) === id) : null;
          const cur  = passes[key] || {};
          const upd  = { ...cur, toolId: id };
          if (tool?.diameter != null) upd.diameter = tool.diameter;
          onChange({ params: { ...p, passes: { ...passes, [key]: upd } } });
        }

        function taperLabel(t) {
          if (t.tipDiameter != null) {
            const tip = isInch ? (t.tipDiameter / MM_PER_INCH).toFixed(4) : t.tipDiameter;
            return `${t.name} (tip ⌀${tip}${distUnit} · ${t.taperAngle ?? '?'}°)`;
          }
          const dia = isInch ? (t.diameter / MM_PER_INCH).toFixed(4) : t.diameter;
          return `${t.name} (⌀${dia}${distUnit})`;
        }

        function endmillLabel(t) {
          const dia = isInch ? (t.diameter / MM_PER_INCH).toFixed(4) : t.diameter;
          return `${t.name} (⌀${dia}${distUnit})`;
        }

        // Pass section header with inline enable checkbox
        function PassHdr({ label, passKey, passObj }) {
          return (
            <div style={{ ...S.section, display: 'flex', alignItems: 'center', gap: 5 }}>
              <input type="checkbox" style={{ margin: 0, cursor: 'pointer' }}
                checked={passObj.enabled !== false}
                onChange={e => setPass(passKey, 'enabled', e.target.checked)} />
              {label}
            </div>
          );
        }

        // Fit-preview calcs (plug only) — driven by taperContour angle
        const wallAngle = tc.angle ?? tk.angle ?? 10;
        const taperRad  = Math.max(0.5, wallAngle / 2) * Math.PI / 180;
        const zRaise    = isPlug ? (p.fitTolerance || 0.127) / Math.tan(taperRad) : 0;

        const partnerType  = isPlug ? 'taperedpocket' : 'taperedplug';
        const partners     = operations.filter(o => o.type === partnerType && o.id !== op.id);
        const linkedId     = p.linkedOpId || '';
        const linkedOp     = operations.find(o => o.id === linkedId) || null;

        return <>
          {/* ─ Link ─ */}
          <div style={S.section}>Link</div>
          <Field label="Linked Partner" tip="Pairs this operation with its pocket or plug counterpart. Syncs bit tip diameter, taper angle, contour lead-in, and top-of-stock to ensure a matched fit between the two operations.">
            <select style={S.select} value={linkedId}
              onChange={e => set('linkedOpId', e.target.value || null)}>
              <option value="">None</option>
              {partners.map(o => <option key={o.id} value={o.id}>{o.name}</option>)}
            </select>
          </Field>
          {linkedOp && (
            <div style={{ padding: '1px 0 4px', fontSize: 9, color: '#9966ff', lineHeight: 1.5 }}>
              ⛓ Syncing: Bit (tip ⌀, angle) · Corner angle · Contour lead-in · Top of stock
            </div>
          )}

          {/* Reactive entity-assignment guard — reads op.selectedIds directly so it
              clears immediately after the Assign button is clicked, not after recalculate. */}
          {!op.selectedIds?.length && (
            <div style={{ margin: '4px 0 6px', padding: '5px 8px', background: '#2a1a00', border: '1px solid #664400', borderRadius: 3, fontSize: 10, color: '#ffaa44' }}>
              ⚠ Select entities on the canvas then click ← Assign before calculating.
            </div>
          )}

          {/* ─ Pass 1: Taper Contour ─ */}
          <PassHdr label="Taper Contour" passKey="taperContour" passObj={tc} />
          {tc.enabled !== false && <>
            <Field label="Tool" tip="Select a tapered or engraving bit from your Tool Library, or enter tip diameter and angle manually below.">
              <select style={S.select} value={tc.toolId || ''} onChange={e => selectTaperPass('taperContour', e)}>
                <option value="">Manual settings...</option>
                {taperTools.map(t => <option key={t.id} value={t.id}>{taperLabel(t)}</option>)}
              </select>
            </Field>
            <Field label="Tip Diameter" unit={distUnit} tip="Diameter at the very tip of the tapered bit. Enter 0 for a sharp-point V-bit. A non-zero tip gives a flat bottom at the narrowest cuts.">
              <NumInput value={toDisp(tc.tipDia ?? 0.5)} onChange={v => setPass('taperContour', 'tipDia', toMM(v))} min={0} step={isInch ? 0.001 : 0.01} />
            </Field>
            <Field label="Taper Angle" unit="°" tip="Wall angle from vertical in degrees. Must match your actual bit angle. Determines how steep the tapered walls are cut. Typical: 5–15°.">
              <NumInput value={tc.angle ?? 10} onChange={v => setPass('taperContour', 'angle', v)} min={1} max={60} step={0.5} />
            </Field>
            <Field label="Spindle RPM" unit="rpm" tip="Spindle speed for the taper contour pass. Typical: 18,000–24,000 RPM for small tapered bits.">
              <NumInput value={tc.rpm || 24000} onChange={v => setPass('taperContour', 'rpm', v)} step={100} />
            </Field>
            <Field label="Feed Rate" unit={feedUnit} tip="XY cutting speed for the taper contour pass.">
              <NumInput value={toDisp(tc.feed ?? 1000)} onChange={v => setPass('taperContour', 'feed', toMM(v))} step={isInch ? 1 : 50} />
            </Field>
            <Field label="Plunge Rate" unit={feedUnit} tip="Z-axis entry speed. Keep lower than feed rate. Typical: 25–40% of feed rate.">
              <NumInput value={toDisp(tc.plunge ?? 300)} onChange={v => setPass('taperContour', 'plunge', toMM(v))} step={fStep} />
            </Field>
            <Field label="Lead-in" tip="How the tool first enters the cut.\nPlunge: straight down.\nRamp: angled entry.\nTangential Arc: smooth curved entry — best for finish contours.">
              <Sel value={tc.leadInStyle || 'plunge'} onChange={v => setPass('taperContour', 'leadInStyle', v)} options={[['plunge','Plunge'],['ramp','Ramp'],['arc','Tangential Arc']]} />
            </Field>
            {tc.leadInStyle === 'ramp' && (
              <Field label="Ramp Angle" unit="°" tip="Slope angle of the ramp entry. Typical: 1–5°.">
                <NumInput value={tc.leadInRampAngle || 3} onChange={v => setPass('taperContour', 'leadInRampAngle', v)} min={0.5} max={30} />
              </Field>
            )}
            {tc.leadInStyle === 'arc' && (
              <Field label="Arc Radius" unit={distUnit} tip="Radius of the tangential arc lead-in. Typically 50–100% of tip diameter.">
                <NumInput value={toDisp(tc.leadInArcRadius ?? Math.max(0.5, (tc.tipDia || 0.5)))} onChange={v => setPass('taperContour', 'leadInArcRadius', toMM(v))} min={isInch ? 0.01 : 0.25} step={dStep} />
              </Field>
            )}
          </>}

          {/* ─ Pass 2: Taper Cleanup ─ */}
          <PassHdr label="Taper Cleanup" passKey="taperCleanup" passObj={tk} />
          {tk.enabled !== false && <>
            <Field label="Tool" tip="Select a tapered or engraving bit for the cleanup pass.">
              <select style={S.select} value={tk.toolId || ''} onChange={e => selectTaperPass('taperCleanup', e)}>
                <option value="">Manual settings...</option>
                {taperTools.map(t => <option key={t.id} value={t.id}>{taperLabel(t)}</option>)}
              </select>
            </Field>
            <Field label="Tip Diameter" unit={distUnit} tip="Diameter at the very tip of the cleanup bit. Usually matches the taper contour bit.">
              <NumInput value={toDisp(tk.tipDia ?? 0.5)} onChange={v => setPass('taperCleanup', 'tipDia', toMM(v))} min={0} step={isInch ? 0.001 : 0.01} />
            </Field>
            <Field label="Taper Angle" unit="°" tip="Wall angle from vertical in degrees. Usually matches the taper contour bit angle.">
              <NumInput value={tk.angle ?? 10} onChange={v => setPass('taperCleanup', 'angle', v)} min={1} max={60} step={0.5} />
            </Field>
            <Field label="Spindle RPM" unit="rpm" tip="Spindle speed for the cleanup pass.">
              <NumInput value={tk.rpm || 24000} onChange={v => setPass('taperCleanup', 'rpm', v)} step={100} />
            </Field>
            <Field label="Feed Rate" unit={feedUnit} tip="XY cutting speed for the cleanup pass.">
              <NumInput value={toDisp(tk.feed ?? 1000)} onChange={v => setPass('taperCleanup', 'feed', toMM(v))} step={isInch ? 1 : 50} />
            </Field>
            <Field label="Plunge Rate" unit={feedUnit} tip="Z-axis entry speed for the cleanup pass.">
              <NumInput value={toDisp(tk.plunge ?? 300)} onChange={v => setPass('taperCleanup', 'plunge', toMM(v))} step={fStep} />
            </Field>
            <Field label="Wall Stock" unit={distUnit} tip="Material left on the tapered wall surface for this cleanup pass. 0 = cut to final size. Typical: 0.1–0.3 mm if a further finishing pass follows.">
              <NumInput value={toDisp(tk.wallStock ?? 0.254)} onChange={v => setPass('taperCleanup', 'wallStock', toMM(v))} min={0} step={isInch ? 0.001 : 0.02} />
            </Field>
            <CheckField label="Rest Machining" value={!!tk.restMachining} onChange={v => setPass('taperCleanup', 'restMachining', v)} tip="Only cuts areas the previous (larger) tool couldn't reach." />
            {tk.restMachining && <Field label="Prev Tool Dia" unit={distUnit} tip="Diameter of the previous tool whose leftover material this pass will clean up.">
              <NumInput value={toDisp(tk.prevDiameter ?? 1.5875)} onChange={v => setPass('taperCleanup', 'prevDiameter', toMM(v))} min={isInch ? 0.004 : 0.1} step={isInch ? 0.001 : 0.01} />
            </Field>}
          </>}

          {/* ─ Pass 3: Detail Endmill ─ */}
          <PassHdr label="Detail Endmill" passKey="detailEndmill" passObj={de} />
          {de.enabled !== false && <>
            <Field label="Tool" tip="Select a small flat end mill for the detail pocket floor pass.">
              <select style={S.select} value={de.toolId || ''} onChange={e => selectEndmillPass('detailEndmill', e)}>
                <option value="">Manual settings...</option>
                {endmillTools.map(t => <option key={t.id} value={t.id}>{endmillLabel(t)}</option>)}
              </select>
            </Field>
            <Field label="Diameter" unit={distUnit} tip="Cutting diameter of the detail end mill. Smaller than the bulk end mill — clears corners and fine detail the larger bit can't reach.">
              <NumInput value={toDisp(de.diameter ?? 1.5875)} onChange={v => setPass('detailEndmill', 'diameter', toMM(v))} min={isInch ? 0.01 : 0.25} step={isInch ? 0.001 : 0.01} />
            </Field>
            <Field label="Spindle RPM" unit="rpm" tip="Spindle speed for the detail end mill pass.">
              <NumInput value={de.rpm || 18000} onChange={v => setPass('detailEndmill', 'rpm', v)} step={100} />
            </Field>
            <Field label="Feed Rate" unit={feedUnit} tip="XY cutting speed for the detail pass.">
              <NumInput value={toDisp(de.feed ?? 800)} onChange={v => setPass('detailEndmill', 'feed', toMM(v))} step={isInch ? 2 : 50} />
            </Field>
            <Field label="Plunge Rate" unit={feedUnit} tip="Z-axis entry speed for the detail pass.">
              <NumInput value={toDisp(de.plunge ?? 300)} onChange={v => setPass('detailEndmill', 'plunge', toMM(v))} step={fStep} />
            </Field>
            <Field label="Depth/Pass" unit={distUnit} tip="Maximum depth per cutting pass for the detail end mill. Typical: 0.5–1× tool diameter.">
              <NumInput value={toDisp(de.depthPerPass ?? (de.diameter || 1.5875))} onChange={v => setPass('detailEndmill', 'depthPerPass', toMM(v))} min={isInch ? 0.001 : 0.1} step={dStep} />
            </Field>
            <Field label="Num Passes" tip="Calculated as Pocket Depth ÷ Depth/Pass. Edit to adjust depth per pass proportionally.">
              <NumInput value={Math.max(1, Math.ceil((p.pocketDepth ?? 5) / (de.depthPerPass ?? (de.diameter || 1.5875))))} onChange={v => { const n = Math.max(1, Math.round(v)); setPass('detailEndmill', 'depthPerPass', (p.pocketDepth ?? 5) / n); }} min={1} step={1} />
            </Field>
            <Field label="Wall Stock" unit={distUnit} tip="Material left on the pocket wall for this pass. 0 = cut to final size.">
              <NumInput value={toDisp(de.wallStock ?? 0.254)} onChange={v => setPass('detailEndmill', 'wallStock', toMM(v))} min={0} step={isInch ? 0.001 : 0.02} />
            </Field>
            <CheckField label="Rest Machining" value={!!de.restMachining} onChange={v => setPass('detailEndmill', 'restMachining', v)} tip="Only cuts areas the bulk end mill couldn't reach. Enable when the detail bit follows the bulk end mill." />
            {de.restMachining && <Field label="Prev Tool Dia" unit={distUnit} tip="Diameter of the previous (bulk) end mill.">
              <NumInput value={toDisp(de.prevDiameter ?? 6.35)} onChange={v => setPass('detailEndmill', 'prevDiameter', toMM(v))} min={isInch ? 0.004 : 0.1} step={isInch ? 0.001 : 0.01} />
            </Field>}
            <Field label="Lead-in" tip="Plunge: straight down at entry.\nHelical: spiral descent — gentler on small end mills.">
              <Sel value={de.leadInStyle || 'plunge'} onChange={v => setPass('detailEndmill', 'leadInStyle', v)} options={[['plunge','Plunge'],['helical','Helical']]} />
            </Field>
            {de.leadInStyle === 'helical' && (
              <Field label="Helix Radius" unit={distUnit} tip="Radius of the helical entry spiral. Must fit inside the cleared area. Typical: 20–40% of tool diameter.">
                <NumInput value={toDisp(de.leadInArcRadius ?? (de.diameter || 1.5875) / 4)} onChange={v => setPass('detailEndmill', 'leadInArcRadius', toMM(v))} min={isInch ? 0.01 : 0.25} step={dStep} />
              </Field>
            )}
          </>}

          {/* ─ Pass 4: Bulk Endmill ─ */}
          <PassHdr label="Bulk Endmill" passKey="bulkEndmill" passObj={be} />
          {be.enabled !== false && <>
            <Field label="Tool" tip="Select a standard flat end mill for the bulk pocket clearing pass.">
              <select style={S.select} value={be.toolId || ''} onChange={e => selectEndmillPass('bulkEndmill', e)}>
                <option value="">Manual settings...</option>
                {endmillTools.map(t => <option key={t.id} value={t.id}>{endmillLabel(t)}</option>)}
              </select>
            </Field>
            <Field label="Diameter" unit={distUnit} tip="Cutting diameter of the bulk end mill. Larger diameter clears faster but can't reach fine features — the detail end mill handles those.">
              <NumInput value={toDisp(be.diameter ?? 6.35)} onChange={v => setPass('bulkEndmill', 'diameter', toMM(v))} min={isInch ? 0.01 : 0.25} step={isInch ? 0.001 : 0.01} />
            </Field>
            <Field label="Spindle RPM" unit="rpm" tip="Spindle speed for the bulk end mill pass.">
              <NumInput value={be.rpm || 18000} onChange={v => setPass('bulkEndmill', 'rpm', v)} step={100} />
            </Field>
            <Field label="Feed Rate" unit={feedUnit} tip="XY cutting speed for the bulk pass. Can typically be higher than the detail pass.">
              <NumInput value={toDisp(be.feed ?? 1500)} onChange={v => setPass('bulkEndmill', 'feed', toMM(v))} step={isInch ? 2 : 50} />
            </Field>
            <Field label="Plunge Rate" unit={feedUnit} tip="Z-axis entry speed for the bulk pass.">
              <NumInput value={toDisp(be.plunge ?? 500)} onChange={v => setPass('bulkEndmill', 'plunge', toMM(v))} step={fStep} />
            </Field>
            <Field label="Depth/Pass" unit={distUnit} tip="Maximum depth per cutting pass for the bulk end mill. Typical: 0.5–1× tool diameter.">
              <NumInput value={toDisp(be.depthPerPass ?? (be.diameter || 6.35))} onChange={v => setPass('bulkEndmill', 'depthPerPass', toMM(v))} min={isInch ? 0.001 : 0.1} step={dStep} />
            </Field>
            <Field label="Num Passes" tip="Calculated as Pocket Depth ÷ Depth/Pass. Edit to adjust depth per pass proportionally.">
              <NumInput value={Math.max(1, Math.ceil((p.pocketDepth ?? 5) / (be.depthPerPass ?? (be.diameter || 6.35))))} onChange={v => { const n = Math.max(1, Math.round(v)); setPass('bulkEndmill', 'depthPerPass', (p.pocketDepth ?? 5) / n); }} min={1} step={1} />
            </Field>
            <Field label="Wall Stock" unit={distUnit} tip="Material left on the pocket wall for the bulk pass. Leave stock here for the detail pass to clean up. Typical: 0.2–0.5 mm.">
              <NumInput value={toDisp(be.wallStock ?? 0.254)} onChange={v => setPass('bulkEndmill', 'wallStock', toMM(v))} min={0} step={isInch ? 0.001 : 0.02} />
            </Field>
            <CheckField label="Rest Machining" value={!!be.restMachining} onChange={v => setPass('bulkEndmill', 'restMachining', v)} tip="Only cuts areas a previous even larger tool couldn't reach." />
            {be.restMachining && <Field label="Prev Tool Dia" unit={distUnit} tip="Diameter of the previous (larger) tool.">
              <NumInput value={toDisp(be.prevDiameter ?? 12.7)} onChange={v => setPass('bulkEndmill', 'prevDiameter', toMM(v))} min={isInch ? 0.004 : 0.1} step={isInch ? 0.001 : 0.01} />
            </Field>}
            <Field label="Lead-in" tip="Plunge: straight down at entry.\nHelical: spiral descent — gentler on the tool.">
              <Sel value={be.leadInStyle || 'plunge'} onChange={v => setPass('bulkEndmill', 'leadInStyle', v)} options={[['plunge','Plunge'],['helical','Helical']]} />
            </Field>
            {be.leadInStyle === 'helical' && (
              <Field label="Helix Radius" unit={distUnit} tip="Radius of the helical entry spiral. Typical: 20–40% of tool diameter.">
                <NumInput value={toDisp(be.leadInArcRadius ?? (be.diameter || 6.35) / 4)} onChange={v => setPass('bulkEndmill', 'leadInArcRadius', toMM(v))} min={isInch ? 0.01 : 0.25} step={dStep} />
              </Field>
            )}
          </>}

          <div style={S.section}>Cut Side</div>
          <Field label="Cut Side" tip="Inside (Pocket): cuts the female tapered recess.\nOutside (Plug): cuts the male tapered piece.">
            <Sel
              value={p.cutSide ?? (isPlug ? 'outside' : 'inside')}
              onChange={v => set('cutSide', v)}
              options={[['inside', 'Inside (Pocket)'], ['outside', 'Outside (Plug)']]}
            />
          </Field>
          <CheckField label="Mirror X" value={!!p.mirrorX} onChange={v => set('mirrorX', v)} tip="Flips the cut profile horizontally. Use when the pocket or plug is a mirror image of the drawn profile." />

          <div style={S.section}>Depth</div>
          {isPlug && linkedOp ? <>
            <Field label="Plug Height Offset" unit={distUnit} tip="Extra height added to the plug so it protrudes slightly above the pocket opening. Creates the friction-fit engagement. Typical: 0.05–0.15 mm.">
              <NumInput value={toDisp(p.plugHeightOffset ?? PLUG_HEIGHT_OFFSET_MM)} onChange={v => set('plugHeightOffset', toMM(v))} min={0} step={dStep} />
            </Field>
            <Field label="Plug Total Depth" unit={distUnit}>
              <span style={{ flex: 1, background: '#0a0a18', border: '1px solid #1a1a38', color: '#88aacc', borderRadius: 3, padding: '2px 5px', fontSize: 11, minWidth: 0 }}>
                {toDisp(p.pocketDepth ?? 5).toFixed(isInch ? 4 : 3)}
              </span>
            </Field>
            <div style={{ fontSize: 9, color: '#776699', paddingBottom: 3, lineHeight: 1.4 }}>
              = pocket depth ({toDisp(linkedOp.params.pocketDepth ?? 5).toFixed(isInch ? 4 : 3)} {distUnit}) + offset
            </div>
          </> : (
            <Field label="Pocket Depth" unit={distUnit} tip="Total depth of the tapered pocket or plug geometry measured from the stock surface.">
              <NumInput value={toDisp(p.pocketDepth ?? 5)} onChange={v => set('pocketDepth', toMM(v))} min={isInch ? 0.01 : 0.25} step={dStep} />
            </Field>
          )}
          <Field label="Top of Stock" unit={distUnit} tip="Z position of the workpiece surface. Usually 0.">
            <NumInput value={toDisp(p.topZ ?? 0)} onChange={v => set('topZ', toMM(v))} step={isInch ? 0.02 : 0.5} />
          </Field>
          <Field label="Safe Z" unit={distUnit} tip="Clearance height for rapid moves between passes. Must clear all clamps and fixtures.">
            <NumInput value={toDisp(p.safeZ ?? 10)} onChange={v => set('safeZ', toMM(v))} step={isInch ? 0.05 : 1} />
          </Field>

          <div style={S.section}>Corner Relief</div>
          <Field label="Sharp Corner Angle" unit="°" tip="Interior angles sharper than this threshold get a corner relief (dogbone) cut added automatically. 180° = treat all non-straight corners as sharp. Typical: 90–150°.">
            <NumInput value={p.sharpCornerAngle ?? 180} onChange={v => set('sharpCornerAngle', v)} min={90} max={180} step={1} />
          </Field>

          {isPlug && (() => {
            const engDepthIn = zRaise / MM_PER_INCH;
            const fitQuality = engDepthIn < 0.030 ? 'tight' : engDepthIn > 0.080 ? 'loose' : 'ideal';
            const fitColor   = { tight: '#ff4444', ideal: '#44cc66', loose: '#ffaa33' }[fitQuality];
            const fitBadge   = { tight: '● Too tight', ideal: '● Ideal', loose: '● Loose' }[fitQuality];
            const readout    = { flex: 1, background: '#0a0a18', border: '1px solid #1a1a38', color: '#88aacc', borderRadius: 3, padding: '2px 5px', fontSize: 11, minWidth: 0 };
            return <>
              <div style={S.section}>Fit</div>
              <Field label="Fit Tolerance" unit={distUnit} tip="Lateral gap between the mated pocket and plug at the midpoint of engagement. Smaller = tighter fit. Typical: 0.05–0.15 mm. Changes Z Raise below.">
                <NumInput value={toDisp(p.fitTolerance ?? 0.127)} onChange={v => set('fitTolerance', toMM(v))} min={0} step={isInch ? 0.0005 : 0.01} />
              </Field>
              <Field label="Z Raise (calc.)" unit={distUnit} tip="Calculated height the plug sits above flush given the Fit Tolerance and Taper Angle. Read-only — changes automatically when those values change.">
                <span style={readout}>{toDisp(zRaise).toFixed(isInch ? 4 : 3)}</span>
              </Field>
              <div style={S.section}>Fit Preview</div>
              <Field label="Engagement Depth" unit={distUnit}>
                <span style={readout}>{toDisp(zRaise).toFixed(isInch ? 4 : 3)}</span>
                <span style={{ color: fitColor, fontSize: 10, flexShrink: 0, fontWeight: 600 }}>{fitBadge}</span>
              </Field>
              <Field label="Interference" unit={distUnit}>
                <span style={readout}>{toDisp(p.fitTolerance ?? 0.127).toFixed(isInch ? 4 : 3)}</span>
              </Field>
            </>;
          })()}
        </>;
      })()}

      {/* ── V-Carve ── */}
      {op.type === 'vcarve' && <>
        {toolSelect}
        <div style={S.section}>V-Bit Geometry</div>
        <Field label="Half Angle" unit="°" tip="Half the included angle of the V-bit. A 60° V-bit has a 30° half angle. Determines how deep the tool cuts for a given groove width.">
          <NumInput value={p.halfAngle ?? 15} onChange={v => set('halfAngle', v)} min={1} max={60} step={0.5} />
        </Field>
        <Field label="Tip Diameter" unit={distUnit} tip="Diameter of the V-bit tip. Enter 0 for a sharp-point bit. A non-zero tip produces a flat-bottom groove at narrow features.">
          <NumInput value={toDisp(p.tipDiameter ?? 0)} onChange={v => set('tipDiameter', toMM(v))} min={0} step={isInch ? 0.001 : 0.01} />
        </Field>
        <div style={{ fontSize: 9, color: '#555577', paddingBottom: 3, lineHeight: 1.4 }}>
          Set tip ⌀ to 0 for a pointed V-bit. Non-zero = flat-bottom V-bit.
        </div>
        <div style={S.section}>Depth</div>
        <Field label="Max Depth" unit={distUnit} tip="Maximum V-carve depth. Wide features that would need a deeper cut are flat-cleared to this depth instead of plunging past it.">
          <NumInput value={toDisp(p.maxDepth ?? 15)} onChange={v => set('maxDepth', toMM(v))} min={isInch ? 0.004 : 0.1} step={dStep} />
        </Field>
        <Field label="Flat Depth" unit={distUnit} tip="Minimum depth cut at all shape edges. 0 = exact V intersection at the boundary. A non-zero value raises the floor at the edges slightly, creating a small flat at the shape outline.">
          <NumInput value={toDisp(p.flatDepth ?? 0)} onChange={v => set('flatDepth', toMM(v))} min={0} step={dStep} />
        </Field>
        <div style={{ fontSize: 9, color: '#555577', paddingBottom: 3, lineHeight: 1.4 }}>
          Flat depth = min cut at shape edges (0 = pointed intersection at boundary).
        </div>
        <Field label="Top of Stock" unit={distUnit} tip="Z position of the workpiece surface. Usually 0.">
          <NumInput value={toDisp(p.topZ ?? 0)} onChange={v => set('topZ', toMM(v))} step={isInch ? 0.02 : 0.5} />
        </Field>
        {commonSpeeds}
      </>}

      {/* ── Text Engraving ── */}
      {op.type === 'text' && <>
        <div style={S.section}>Text</div>
        <div style={S.row}>
          <span style={S.label}>Content<Tip text="Text string to engrave. Press Enter for a new line. Text scales proportionally with Cap Height." /></span>
          <textarea
            style={{ ...S.input, resize: 'vertical', minHeight: 48, fontFamily: 'monospace', lineHeight: 1.4 }}
            value={p.text || ''}
            rows={2}
            onChange={e => onChange({ params: { ...p, text: e.target.value, textContoursRel: null, textBoundsRel: null } })}
          />
        </div>
        <div style={S.section}>Font</div>
        <Field label="Font" tip="System font used to generate letter outlines. TrueType (TTF) and OpenType (OTF) fonts are supported. Click 'Generate Geometry' after changing font or text.">
          {loadingFonts
            ? <span style={{ color: '#555577', fontSize: 10 }}>Loading fonts…</span>
            : <select
                style={S.select}
                value={p.fontPath || ''}
                onChange={e => {
                  const sel = fontList.find(f => f.path === e.target.value);
                  if (sel) onChange({ params: { ...p, fontFamily: sel.family, fontPath: sel.path, textContoursRel: null, textBoundsRel: null } });
                }}>
                <option value="">Select a font…</option>
                {fontList.map(f => <option key={f.path} value={f.path}>{f.family}</option>)}
              </select>
          }
        </Field>
        <Field label="Cap Height" unit={distUnit} tip="Height of capital letters in the output. All other characters and line spacing scale proportionally from this value.">
          <NumInput value={toDisp(p.fontSize ?? 10)} onChange={v => onChange({ params: { ...p, fontSize: toMM(v), textContoursRel: null, textBoundsRel: null } })} min={isInch ? 0.04 : 1} step={dStep} />
        </Field>
        <div style={S.section}>Output Mode</div>
        <Field label="Mode" tip="Engraved: V-bit traces along letter centerlines — lightweight, good for simple text.\nOutlined: contour-cuts around the letter edges.\nFilled: pocket-clears the interior of each letter solid.">
          <Sel value={p.outputMode || 'engraved'} onChange={v => set('outputMode', v)}
               options={[['engraved','Engraved (V-bit trace)'],['outlined','Outlined (contour cut)'],['filled','Filled (pocket)']]} />
        </Field>
        {(p.outputMode || 'engraved') === 'filled' && (
          <Field label="Stepover" unit={distUnit} tip="In Filled mode: stepover between parallel passes inside each letter. Smaller = better fill coverage but more passes.">
            <NumInput value={toDisp(p.stepover ?? 0.45)} onChange={v => set('stepover', toMM(v))} min={isInch ? 0.001 : 0.01} step={dStep} />
          </Field>
        )}
        <div style={S.section}>Geometry</div>
        <div style={{ fontSize: 10, padding: '2px 0 4px 0', color: p.textContoursRel ? '#44cc88' : '#aa8844' }}>
          {p.textContoursRel ? `Ready — ${p.textContoursRel.length} glyph(s)` : 'Generate geometry after setting text and font'}
        </div>
        <Field label="">
          <button
            disabled={!p.fontPath || !p.text || generatingGeometry}
            style={{ ...S.input, cursor: (!p.fontPath || !p.text || generatingGeometry) ? 'default' : 'pointer', textAlign: 'center', opacity: (!p.fontPath || !p.text) ? 0.4 : 1 }}
            onClick={generateTextGeometry}>
            {generatingGeometry ? 'Generating…' : 'Generate Geometry'}
          </button>
        </Field>
        <div style={S.section}>Placement</div>
        {p.textBoundsRel && (
          <div style={{ fontSize: 10, color: '#666688', padding: '0 0 4px 124px' }}>
            {isInch
              ? `${((p.textBoundsRel.width || 0) / MM_PER_INCH).toFixed(3)}" × ${((p.textBoundsRel.height || 0) / MM_PER_INCH).toFixed(3)}"`
              : `${(p.textBoundsRel.width || 0).toFixed(1)} × ${(p.textBoundsRel.height || 0).toFixed(1)} mm`}
          </div>
        )}
        <Field label="Position X" unit={distUnit} tip="X coordinate of the text baseline start point in work coordinates.">
          <NumInput value={toDisp(p.textX ?? 0)} onChange={v => set('textX', toMM(v))} step={dStep} />
        </Field>
        <Field label="Position Y" unit={distUnit} tip="Y coordinate of the text baseline start point in work coordinates.">
          <NumInput value={toDisp(p.textY ?? 0)} onChange={v => set('textY', toMM(v))} step={dStep} />
        </Field>
        <Field label="">
          <button
            disabled={!p.textContoursRel}
            style={{ ...S.input, cursor: !p.textContoursRel ? 'default' : 'pointer', textAlign: 'center', opacity: !p.textContoursRel ? 0.4 : 1,
              background: (state.textPlacementActive && state.textPlacementOpId === op.id) ? '#1a3a2a' : '#0d0d20',
              borderColor: (state.textPlacementActive && state.textPlacementOpId === op.id) ? '#44aa88' : '#2a2a50',
              color: (state.textPlacementActive && state.textPlacementOpId === op.id) ? '#88cc99' : '#ccccee' }}
            onClick={() => {
              const isActive = state.textPlacementActive && state.textPlacementOpId === op.id;
              dispatch({ type: 'SET_TEXT_PLACEMENT', payload: { active: !isActive, opId: isActive ? null : op.id } });
            }}>
            {(state.textPlacementActive && state.textPlacementOpId === op.id) ? 'Done Placing' : 'Place on Canvas'}
          </button>
        </Field>
        {toolSelect}
        {commonDepth}
        {commonSpeeds}
      </>}

      {/* ── Dogbone Fillets ── */}
      {op.type === 'dogbone' && <>
        {toolSelect}
        <div style={S.section}>Corner Selection</div>
        <Field label="Mode" tip="Auto: adds dogbone relief to all sharp corners found in the selected entities — no manual selection needed.\nManual: calculate the toolpath first, then click specific corners on the canvas to toggle relief on each corner individually.">
          <Sel value={p.cornerMode || 'auto'} onChange={v => set('cornerMode', v)}
               options={[['auto','Auto (all corners)'],['manual','Manual (pick on canvas)']]} />
        </Field>
        {(p.cornerMode || 'auto') === 'manual' && (() => {
          const placed = (p.selectedCorners || []).length;
          const isActive = state.dogboneSelectionActive && state.dogboneSelectionOpId === op.id;
          const noContour = !op.toolpath?.candidateCorners?.length;
          return <>
            <div style={S.row}>
              <span style={S.label}>Corners selected</span>
              <span style={{ color: placed > 0 ? '#88ffaa' : '#666688', fontSize: 11 }}>{placed}</span>
            </div>
            {noContour && (
              <div style={{ ...S.row, color: '#aa8844', fontSize: 10, paddingLeft: 4 }}>
                Calculate toolpath first to enable selection
              </div>
            )}
            <Field label="">
              <button
                disabled={noContour}
                style={{ ...S.input, cursor: noContour ? 'default' : 'pointer', textAlign: 'center', opacity: noContour ? 0.4 : 1,
                  background: isActive ? '#1a3a2a' : '#0d0d20',
                  borderColor: isActive ? '#44aa88' : '#2a2a50',
                  color: isActive ? '#88cc99' : '#ccccee' }}
                onClick={() => dispatch({ type: 'SET_DOGBONE_SELECTION', payload: { active: !isActive, opId: isActive ? null : op.id } })}>
                {isActive ? 'Done Selecting' : 'Select on Canvas'}
              </button>
            </Field>
            {placed > 0 && (
              <Field label="">
                <button style={{ ...S.input, cursor: 'pointer', textAlign: 'center', color: '#ff8888' }}
                  onClick={() => dispatch({ type: 'UPDATE_DOGBONE_CORNERS', payload: { opId: op.id, corners: [] } })}>
                  Clear All
                </button>
              </Field>
            )}
          </>;
        })()}
        {commonDepth}
        {commonSpeeds}
      </>}

      {/* ── 3D Raster (STL) ── */}
      {op.type === 'stlraster' && <>
        {toolSelect}

        <div style={S.section}>Direction</div>
        <Field label="Pass Direction" tip="X Lines: tool sweeps along X, stepping in Y — best for parts wider in X.\nY Lines: tool sweeps along Y, stepping in X.\nCrosshatch (Both): runs X then Y — best surface finish, doubles cutting time.">
          <Sel value={p.direction ?? 'x'} onChange={v => set('direction', v)}
               options={[['x','X Lines (↔)'],['y','Y Lines (↕)'],['both','Crosshatch (↔↕)']]} />
        </Field>

        <div style={S.section}>Rough Pass</div>
        <CheckField label="Enabled" value={!!p.roughEnabled} onChange={v => set('roughEnabled', v)}
          tip="Run a fast rough pass before the finish pass. Uses a larger stepover and stays above the surface by the allowance amount — removes bulk material quickly." />
        {p.roughEnabled && <>
          <Field label="Stepover" unit={distUnit} tip="Step between rough raster lines. 3–5× the finish stepover is typical — e.g. 6–10 mm for a 6 mm ball-nose.">
            <NumInput value={toDisp(p.roughStepover ?? 6)} onChange={v => set('roughStepover', toMM(v))} min={isInch ? 0.01 : 0.5} step={dStep} />
          </Field>
          <Field label="Allowance" unit={distUnit} tip="How far above the surface the rough pass stays. The finish pass then removes this remaining material. Typical: 0.5–2 mm.">
            <NumInput value={toDisp(p.roughAllowance ?? 1)} onChange={v => set('roughAllowance', toMM(v))} min={0} step={isInch ? 0.005 : 0.1} />
          </Field>
          <Field label="Feed Rate" unit={feedUnit} tip="Feed rate for the rough pass. Can be faster than finish since surface quality isn't critical.">
            <NumInput value={toDisp(p.roughFeedRate ?? p.feedRate ?? 2000)} onChange={v => set('roughFeedRate', toMM(v))} step={isInch ? 2 : 50} min={isInch ? 0.04 : 1} />
          </Field>
        </>}

        <div style={S.section}>Finish Pass</div>
        <CheckField label="Enabled" value={p.finishEnabled !== false} onChange={v => set('finishEnabled', v)}
          tip="Run a finish pass that follows the actual surface using the drop-cutter algorithm. This is the primary surface-quality pass." />
        {p.finishEnabled !== false && <>
          <Field label="Finish Tool" tip="Select a ball-nose end mill for the finish pass. Leave as 'Same as rough' to reuse the primary tool. A smaller ball-nose gives tighter scallops and smoother surfaces.">
            <select style={S.select} value={p.finishToolId || ''} onChange={e => {
              const toolId = e.target.value || null;
              const tool = toolId ? tools.find(t => t.id === toolId) : null;
              onChange({ params: { ...p, finishToolId: toolId, finishToolDiameter: tool ? tool.diameter : null } });
            }}>
              <option value="">Same as rough tool</option>
              {tools.map(t => (
                <option key={t.id} value={t.id}>
                  {t.name} (⌀{isInch ? (t.diameter / MM_PER_INCH).toFixed(4) : t.diameter}{distUnit})
                </option>
              ))}
            </select>
          </Field>
          {!p.finishToolId && (
            <Field label="Finish Diameter" unit={distUnit} tip="Diameter of the ball-nose finish cutter. Controls the drop-cutter kernel radius — smaller diameter = more accurate surface following but slower.">
              <NumInput value={toDisp(p.finishToolDiameter ?? p.toolDiameter ?? 6.35)} onChange={v => set('finishToolDiameter', toMM(v))} min={isInch ? 0.004 : 0.1} step={isInch ? 0.001 : 0.01} />
            </Field>
          )}
          <Field label="Stepover" unit={distUnit} tip="Distance between adjacent finish raster lines. Smaller = smoother scallop but longer run time. Typical: 3–10% of tool diameter for finishing.">
            <NumInput value={toDisp(p.stepover ?? 2)} onChange={v => set('stepover', toMM(v))} min={isInch ? 0.001 : 0.1} step={dStep} />
          </Field>
          <Field label="Z Offset" unit={distUnit} tip="Shift the finish path up (+) or down (−). Use a small positive value (e.g. 0.1 mm) as a final spring-pass allowance, or 0 for full depth.">
            <NumInput value={toDisp(p.zOffset ?? 0)} onChange={v => set('zOffset', toMM(v))} step={isInch ? 0.001 : 0.05} />
          </Field>
        </>}

        <div style={S.section}>Clearance</div>
        <Field label="Safe Z" unit={distUnit} tip="Rapid clearance height between raster lines. Must clear all raised features and clamps.">
          <NumInput value={toDisp(p.safeZ ?? 5)} onChange={v => set('safeZ', toMM(v))} step={isInch ? 0.05 : 1} />
        </Field>
        {commonSpeeds}

        <div style={S.section}>Heightmap</div>
        <Field label="Status" tip="The heightmap is sampled from the STL in the 3D view. Use '⬇ Sample Heights' in the 3D HUD to refresh after moving the stock or reloading the STL.">
          <span style={{ ...S.input, fontSize: 10, color: state.stlHeightmap ? '#88ff88' : '#ff8844' }}>
            {state.stlHeightmap
              ? `${state.stlHeightmap.gridW}×${state.stlHeightmap.gridH} — ready`
              : 'Not sampled — use ⬇ Sample Heights in the 3D view'}
          </span>
        </Field>
      </>}
    </div>
  );
}
