
(function(){
  "use strict";

  /*
   * ESTRUCTURA DEL ARCHIVO (bloques lógicos, de arriba hacia abajo):
   *   1. STATE               — estado global de la app (almacenes, zonas, resultado)
   *   2. TABS / MODAL HELPERS— utilidades de UI genéricas
   *   3. LEAFLET MAP SETUP   — mapa, capas 2D/3D, íconos, marcadores
   *   4. LOCATION PICKING    — selección de puntos en el mapa (con feedback visual)
   *   5. ADDRESS SEARCH      — geocodificación vía Nominatim
   *   6. WAREHOUSE / DEMAND CRUD — alta, edición, borrado y render de tablas
   *   7. SAMPLE DATA / CLEAR / EXPORT / IMPORT — datos de ejemplo y persistencia JSON
   *   8. DISTANCE MODULE     — Haversine, OSRM, caché de distancias, progreso/cancelación
   *   9. TRANSPORTATION SOLVER — VAM + MODI (modo "dividir")
   *  10. EXACT ASSIGNMENT SOLVER — Branch & Bound (modo "no dividir")
   *  11. VALIDATION HELPERS  — parámetros globales y datos de red
   *  12. RUN OPTIMIZATION    — orquesta todo lo anterior
   *  13. RESULTS / KPI / UTILIZATION RENDERING
   *  14. ALERT MODAL
   *  15. MAP MARKERS / ROUTES DRAWING
   *  16. INIT
   * Al ser una única página HTML autocontenida (sin build step), los
   * bloques se organizan por comentarios de sección en vez de módulos
   * ES import/export, pero cada uno agrupa funciones estrechamente
   * relacionadas y puede leerse de forma independiente.
   */

  /* ============== STATE ============== */
  const COLORS = ["#2dd4bf","#f5b942","#c084fc","#60a5fa","#fb7185","#a3e635","#f472b6","#38bdf8","#fbbf24","#4ade80"];
  const DEFAULT_CENTER = [-8.3791, -74.5539]; // Pucallpa, Ucayali, Perú
  const DEFAULT_ZOOM = 13;

  let state = {
    warehouses: [],
    demands: [],
    nextWhId: 1,
    nextDzId: 1,
    lastResult: null
  };

  let editingWhId = null;
  let editingDzId = null;

  /* Caché en memoria de distancias OSRM ya calculadas, por par de coordenadas.
     Evita repetir peticiones de red si se vuelve a optimizar sin mover los puntos. */
  const distanceCache = new Map();
  function distanceCacheKey(a, b){ return `${a.lat.toFixed(6)},${a.lng.toFixed(6)}|${b.lat.toFixed(6)},${b.lng.toFixed(6)}`; }

  /* Controlador para poder cancelar una optimización en curso (aborta fetch OSRM pendientes) */
  let currentOptimizationAbort = null;

  const $ = (sel) => document.querySelector(sel);
  const $all = (sel) => Array.from(document.querySelectorAll(sel));

  /* ---- Iconos SVG (reemplazan emojis para apariencia consistente entre SO) ---- */
  const ICONS = {
    target: '<svg class="icon-svg" viewBox="0 0 24 24"><circle cx="12" cy="12" r="7.5"></circle><circle cx="12" cy="12" r="3"></circle><line x1="12" y1="1.5" x2="12" y2="4.5"></line><line x1="12" y1="19.5" x2="12" y2="22.5"></line><line x1="1.5" y1="12" x2="4.5" y2="12"></line><line x1="19.5" y1="12" x2="22.5" y2="12"></line></svg>',
    edit: '<svg class="icon-svg" viewBox="0 0 24 24"><path d="M12 20h9"></path><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"></path></svg>',
    trash: '<svg class="icon-svg" viewBox="0 0 24 24"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"></path><path d="M10 11v6"></path><path d="M14 11v6"></path><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"></path></svg>',
    warn: '<svg class="icon-svg" viewBox="0 0 24 24" style="width:18px;height:18px;stroke:var(--warn);"><path d="M12 3 1 21h22Z"></path><line x1="12" y1="9" x2="12" y2="14"></line><line x1="12" y1="17.2" x2="12" y2="17.3"></line></svg>',
    danger: '<svg class="icon-svg" viewBox="0 0 24 24" style="width:18px;height:18px;stroke:var(--danger);"><circle cx="12" cy="12" r="9.5"></circle><line x1="12" y1="7" x2="12" y2="13"></line><line x1="12" y1="16.2" x2="12" y2="16.3"></line></svg>'
  };

  function colorFor(index){ return COLORS[index % COLORS.length]; }
  function fmtNum(n, digits){
    if(!isFinite(n)) return "—";
    return n.toLocaleString('es-PE', {minimumFractionDigits:digits||0, maximumFractionDigits:digits||2});
  }
  function fmtMoney(n){ return "$ " + fmtNum(n, 2); }
  function escapeHtml(str){
    return String(str).replace(/[&<>"']/g, m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
  }

  /* ============== THEME TOGGLE (claro/oscuro) ============== */
  // Nota: si esta página se previsualiza dentro del entorno de artifacts de
  // Claude.ai, localStorage puede no estar disponible; en ese caso se usa
  // una variable en memoria como respaldo (la preferencia no persistirá
  // entre recargas, pero el toggle sigue funcionando). Al abrir el archivo
  // descargado directamente en un navegador, localStorage funciona con
  // normalidad y la preferencia sí persiste.
  let inMemoryThemePref = null;
  function readStoredTheme(){
    try{ return window.localStorage.getItem('redlog-theme'); }
    catch(e){ return inMemoryThemePref; }
  }
  function writeStoredTheme(value){
    try{ window.localStorage.setItem('redlog-theme', value); }
    catch(e){ inMemoryThemePref = value; }
  }
  function applyTheme(theme){
    document.body.classList.toggle('light', theme === 'light');
    $('#btnThemeToggle').setAttribute('aria-pressed', theme==='light' ? 'true' : 'false');
  }
  const storedTheme = readStoredTheme();
  const prefersLight = !!(window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches);
  applyTheme(storedTheme || (prefersLight ? 'light' : 'dark'));
  $('#btnThemeToggle').addEventListener('click', ()=>{
    const next = document.body.classList.contains('light') ? 'dark' : 'light';
    applyTheme(next);
    writeStoredTheme(next);
  });

  /* ============== TABS ============== */
  $all('.tab').forEach(tab=>{
    tab.addEventListener('click', ()=>{
      $all('.tab').forEach(t=>t.classList.remove('active'));
      tab.classList.add('active');
      const which = tab.dataset.tab;
      $('#pane-warehouses').style.display = which==='warehouses' ? '' : 'none';
      $('#pane-demands').style.display = which==='demands' ? '' : 'none';
    });
  });

  /* ============== MODAL HELPERS ============== */
  function openModal(id){ $('#'+id).classList.add('open'); }
  function closeModal(id){ $('#'+id).classList.remove('open'); }
  $all('[data-close]').forEach(btn=>{
    btn.addEventListener('click', ()=>{
      closeModal(btn.dataset.close);
      if(btn.dataset.close === 'modalWarehouse' || btn.dataset.close === 'modalDemand') clearPickFeedback();
    });
  });
  $all('.modal-overlay').forEach(ov=>{
    ov.addEventListener('click', (e)=>{ if(e.target === ov) closeModal(ov.id); });
  });

  /* ============== LEAFLET MAP SETUP ============== */
  const map = L.map('map', { zoomControl:true, attributionControl:true }).setView(DEFAULT_CENTER, DEFAULT_ZOOM);

  /* Capa 2D: mapa estándar OpenStreetMap (el original) */
  const topoLayer = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 17,
    attribution: '&copy; OpenStreetMap'
  }).addTo(map);

  /* Capa 3D: imagen satelital/aérea con relieve (Esri World Imagery) */
  const satelliteLayer = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
    maxZoom: 18,               // El usuario puede hacer zoom hasta 18
    maxNativeZoom: 17,         // Pero el servidor solo da tiles hasta 17
    errorTileUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', // tile transparente en caso de error
    attribution: 'Tiles &copy; Esri &mdash; Source: Esri, Maxar, Earthstar Geographics, and the GIS User Community'
  });

  /* Control flotante 3D / 2D (arriba a la derecha del mapa) */
  let currentMapView = '2d';
  const mapViewToggle = L.control({ position:'topright' });
  mapViewToggle.onAdd = function(){
    const container = L.DomUtil.create('div', 'leaflet-bar map-view-toggle');
    container.innerHTML =
      '<button type="button" class="mvt-btn" id="btn3D" title="Vista satelital con relieve">3D</button>' +
      '<button type="button" class="mvt-btn active" id="btn2D" title="Vista topográfica plana">2D</button>';
    L.DomEvent.disableClickPropagation(container);
    L.DomEvent.disableScrollPropagation(container);
    return container;
  };
  mapViewToggle.addTo(map);

  function setMapView(view){
    if(view === currentMapView) return;
    const btn3D = $('#btn3D'), btn2D = $('#btn2D');
    if(view === '3d'){
      map.removeLayer(topoLayer);
      satelliteLayer.addTo(map);
      btn3D.classList.add('active'); btn2D.classList.remove('active');
    } else {
      map.removeLayer(satelliteLayer);
      topoLayer.addTo(map);
      btn2D.classList.add('active'); btn3D.classList.remove('active');
    }
    currentMapView = view;
  }
  $('#btn3D').addEventListener('click', ()=> setMapView('3d'));
  $('#btn2D').addEventListener('click', ()=> setMapView('2d'));

  const whMarkersLayer = L.layerGroup().addTo(map);
  const dzMarkersLayer = L.layerGroup().addTo(map);
  const routesLayer = L.layerGroup().addTo(map);

  function warehouseIcon(color, active){
    return L.divIcon({
      className:'',
      html:`<div style="width:16px;height:16px;background:${active?color:'#3a4a60'};border:2px solid #0a1119;border-radius:3px;opacity:${active?1:0.65};box-shadow:0 1px 4px rgba(0,0,0,.5);"></div>`,
      iconSize:[16,16], iconAnchor:[8,8]
    });
  }
  function demandIcon(color, active){
    return L.divIcon({
      className:'',
      html:`<div style="width:14px;height:14px;background:${active?color:'#3a4a60'};border:2px solid #0a1119;border-radius:50%;opacity:${active?1:0.65};box-shadow:0 1px 4px rgba(0,0,0,.5);"></div>`,
      iconSize:[14,14], iconAnchor:[7,7]
    });
  }

  /* ============== PICKING LOCATION ON MAP ============== */
  let pickKind = null; // 'warehouse' | 'demand'
  let currentPickHandler = null;

  function showPickBanner(text){
    $('#pickBannerText').textContent = text;
    $('#pickBanner').classList.add('show');
  }
  function hidePickBanner(){ $('#pickBanner').classList.remove('show'); }

  function startLocationPicking(kind){
    closeModal('modalWarehouse'); closeModal('modalDemand');
    pickKind = kind;
    showPickBanner(kind==='warehouse' ? 'Haz clic en el mapa para ubicar el almacén' : 'Haz clic en el mapa para ubicar la zona de demanda');
    map.getContainer().style.cursor = 'crosshair';
    currentPickHandler = onPickClick;
    map.on('click', currentPickHandler);
  }
  function cancelPicking(){
    if(currentPickHandler){ map.off('click', currentPickHandler); currentPickHandler = null; }
    hidePickBanner();
    map.getContainer().style.cursor = '';
    pickKind = null;
  }
  $('#btnCancelPick').addEventListener('click', cancelPicking);

  let pickFeedbackMarker = null;
  function showPickFeedback(lat, lng, kind){
    if(pickFeedbackMarker){ map.removeLayer(pickFeedbackMarker); pickFeedbackMarker = null; }
    const color = kind==='warehouse' ? 'var(--accent)' : '#dbe4f0';
    pickFeedbackMarker = L.divIcon({
      className:'',
      html:`<div style="width:22px;height:22px;margin-left:-11px;margin-top:-11px;border-radius:50%;border:2px solid ${color};box-shadow:0 0 0 4px rgba(45,212,191,0.18);"></div>`,
      iconSize:[0,0]
    });
    pickFeedbackMarker = L.marker([lat,lng], {icon: pickFeedbackMarker, interactive:false}).addTo(map);
  }
  function clearPickFeedback(){
    if(pickFeedbackMarker){ map.removeLayer(pickFeedbackMarker); pickFeedbackMarker = null; }
  }

  function onPickClick(e){
    const { lat, lng } = e.latlng;
    const kind = pickKind;
    showPickFeedback(lat, lng, kind);
    cancelPicking();
    if(kind === 'warehouse'){
      $('#whLat').value = lat; $('#whLng').value = lng;
      $('#whLocDisplay').textContent = `${lat.toFixed(5)}, ${lng.toFixed(5)}`;
      openModal('modalWarehouse');
    } else if(kind === 'demand'){
      $('#dzLat').value = lat; $('#dzLng').value = lng;
      $('#dzLocDisplay').textContent = `${lat.toFixed(5)}, ${lng.toFixed(5)}`;
      openModal('modalDemand');
    }
  }

  /* ============== ADDRESS SEARCH (Nominatim) ============== */
  function doAddressSearch(){
    const q = $('#addressSearch').value.trim();
    if(!q) return;
    fetch(`https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(q)}`, { headers:{ 'Accept-Language':'es' } })
      .then(r=>r.json())
      .then(results=>{
        if(results && results[0]){
          map.setView([parseFloat(results[0].lat), parseFloat(results[0].lon)], 15);
        } else {
          showAlert(['warn'], ['No se encontró esa dirección. Intenta con un nombre más específico, un barrio o el nombre de la ciudad.']);
        }
      })
      .catch(()=> showAlert(['warn'], ['No se pudo conectar al servicio de búsqueda de direcciones en este momento.']));
  }
  $('#btnAddressSearch').addEventListener('click', doAddressSearch);
  $('#addressSearch').addEventListener('keydown', (e)=>{ if(e.key==='Enter'){ e.preventDefault(); doAddressSearch(); } });

  /* ============== WAREHOUSE CRUD ============== */
  $('#btnAddWarehouse').addEventListener('click', ()=>{
    editingWhId = null;
    $('#whModalTitle').textContent = "Agregar Almacén";
    $('#whName').value = ""; $('#whCap').value=""; $('#whActive').value="true";
    $('#whLat').value=""; $('#whLng').value=""; $('#whLocDisplay').textContent="—";
    startLocationPicking('warehouse');
  });

  $('#btnRelocateWh').addEventListener('click', ()=>{ startLocationPicking('warehouse'); });

  $('#btnSaveWarehouse').addEventListener('click', ()=>{
    const name = $('#whName').value.trim();
    const lat = parseFloat($('#whLat').value);
    const lng = parseFloat($('#whLng').value);
    const cap = parseFloat($('#whCap').value);
    const active = $('#whActive').value === 'true';
    if(isNaN(lat) || isNaN(lng)){
      showAlert(['warn'], ['Primero ubica el almacén haciendo clic en el mapa.']);
      return;
    }
    if(!name || isNaN(cap) || cap < 0){
      showAlert(['warn'], ['Completa el nombre y una capacidad válida (≥ 0) antes de guardar.']);
      return;
    }
    if(editingWhId){
      const wh = state.warehouses.find(w=>w.id===editingWhId);
      Object.assign(wh, {name, lat, lng, capacity:cap, active});
    } else {
      state.warehouses.push({id: state.nextWhId++, name, lat, lng, capacity:cap, active});
    }
    renderWarehouses();
    redrawMarkers();
    closeModal('modalWarehouse');
    clearPickFeedback();
  });

  function editWarehouse(id){
    const wh = state.warehouses.find(w=>w.id===id);
    if(!wh) return;
    editingWhId = id;
    $('#whModalTitle').textContent = "Editar Almacén";
    $('#whName').value = wh.name; $('#whCap').value = wh.capacity; $('#whActive').value = String(wh.active);
    $('#whLat').value = wh.lat; $('#whLng').value = wh.lng;
    $('#whLocDisplay').textContent = `${wh.lat.toFixed(5)}, ${wh.lng.toFixed(5)}`;
    openModal('modalWarehouse');
  }
  function deleteWarehouse(id){
    state.warehouses = state.warehouses.filter(w=>w.id!==id);
    renderWarehouses(); redrawMarkers();
  }
  function flyToWarehouse(id){
    const wh = state.warehouses.find(w=>w.id===id);
    if(!wh) return;
    map.flyTo([wh.lat, wh.lng], Math.max(map.getZoom(), 15), {duration:0.6});
  }

  function renderWarehouses(){
    const tbody = $('#warehouseTbody');
    tbody.innerHTML = '';
    $('#whCount').textContent = state.warehouses.length;
    if(state.warehouses.length===0){
      tbody.innerHTML = '<tr class="empty-row"><td colspan="4">Aún no hay almacenes. Agrega uno o carga datos de ejemplo.</td></tr>';
      return;
    }
    state.warehouses.forEach((wh, idx)=>{
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td class="name-cell"><span class="swatch" style="background:${colorFor(idx)}"></span>${escapeHtml(wh.name)}</td>
        <td>${fmtNum(wh.capacity,0)}</td>
        <td><span class="status-pill ${wh.active?'status-active':'status-inactive'}">${wh.active?'Activo':'Inactivo'}</span></td>
        <td><div class="row-actions">
          <button class="icon-btn" title="Ver en mapa">${ICONS.target}</button>
          <button class="icon-btn" title="Editar">${ICONS.edit}</button>
          <button class="icon-btn del" title="Eliminar">${ICONS.trash}</button>
        </div></td>`;
      tr.querySelector('[title="Ver en mapa"]').addEventListener('click', ()=>flyToWarehouse(wh.id));
      tr.querySelector('[title="Editar"]').addEventListener('click', ()=>editWarehouse(wh.id));
      tr.querySelector('.icon-btn.del').addEventListener('click', ()=>{
        if(confirm(`¿Eliminar el almacén "${wh.name}"?`)) deleteWarehouse(wh.id);
      });
      tbody.appendChild(tr);
    });
  }

  /* ============== DEMAND CRUD ============== */
  $('#btnAddDemand').addEventListener('click', ()=>{
    editingDzId = null;
    $('#dzModalTitle').textContent = "Agregar Zona de Demanda";
    $('#dzName').value=""; $('#dzDemand').value=""; $('#dzActive').value="true";
    $('#dzLat').value=""; $('#dzLng').value=""; $('#dzLocDisplay').textContent="—";
    startLocationPicking('demand');
  });

  $('#btnRelocateDz').addEventListener('click', ()=>{ startLocationPicking('demand'); });

  $('#btnSaveDemand').addEventListener('click', ()=>{
    const name = $('#dzName').value.trim();
    const lat = parseFloat($('#dzLat').value);
    const lng = parseFloat($('#dzLng').value);
    const demand = parseFloat($('#dzDemand').value);
    const active = $('#dzActive').value === 'true';
    if(isNaN(lat) || isNaN(lng)){
      showAlert(['warn'], ['Primero ubica la zona haciendo clic en el mapa.']);
      return;
    }
    if(!name || isNaN(demand) || demand < 0){
      showAlert(['warn'], ['Completa el nombre y una demanda válida (≥ 0) antes de guardar.']);
      return;
    }
    if(editingDzId){
      const dz = state.demands.find(d=>d.id===editingDzId);
      Object.assign(dz, {name, lat, lng, demand, active});
    } else {
      state.demands.push({id: state.nextDzId++, name, lat, lng, demand, active});
    }
    renderDemands();
    redrawMarkers();
    closeModal('modalDemand');
    clearPickFeedback();
  });

  function editDemand(id){
    const dz = state.demands.find(d=>d.id===id);
    if(!dz) return;
    editingDzId = id;
    $('#dzModalTitle').textContent = "Editar Zona de Demanda";
    $('#dzName').value = dz.name; $('#dzDemand').value = dz.demand; $('#dzActive').value = String(dz.active !== false);
    $('#dzLat').value = dz.lat; $('#dzLng').value = dz.lng;
    $('#dzLocDisplay').textContent = `${dz.lat.toFixed(5)}, ${dz.lng.toFixed(5)}`;
    openModal('modalDemand');
  }
  function deleteDemand(id){
    state.demands = state.demands.filter(d=>d.id!==id);
    renderDemands(); redrawMarkers();
  }
  function flyToDemand(id){
    const dz = state.demands.find(d=>d.id===id);
    if(!dz) return;
    map.flyTo([dz.lat, dz.lng], Math.max(map.getZoom(), 15), {duration:0.6});
  }

  function renderDemands(){
    const tbody = $('#demandTbody');
    tbody.innerHTML = '';
    $('#dzCount').textContent = state.demands.length;
    if(state.demands.length===0){
      tbody.innerHTML = '<tr class="empty-row"><td colspan="4">Aún no hay zonas de demanda.</td></tr>';
      return;
    }
    state.demands.forEach(dz=>{
      const isActive = dz.active !== false;
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td class="name-cell">${escapeHtml(dz.name)}</td>
        <td>${fmtNum(dz.demand,0)}</td>
        <td><span class="status-pill ${isActive?'status-active':'status-inactive'}">${isActive?'Activo':'Inactivo'}</span></td>
        <td><div class="row-actions">
          <button class="icon-btn" title="Ver en mapa">${ICONS.target}</button>
          <button class="icon-btn" title="Editar">${ICONS.edit}</button>
          <button class="icon-btn del" title="Eliminar">${ICONS.trash}</button>
        </div></td>`;
      tr.querySelector('[title="Ver en mapa"]').addEventListener('click', ()=>flyToDemand(dz.id));
      tr.querySelector('[title="Editar"]').addEventListener('click', ()=>editDemand(dz.id));
      tr.querySelector('.icon-btn.del').addEventListener('click', ()=>{
        if(confirm(`¿Eliminar la zona "${dz.name}"?`)) deleteDemand(dz.id);
      });
      tbody.appendChild(tr);
    });
  }

  /* ============== SAMPLE DATA (Pucallpa, Perú) ============== */
  $('#btnLoadSample').addEventListener('click', ()=>{
    if(state.warehouses.length || state.demands.length){
      if(!confirm('Esto reemplazará los datos actuales por el conjunto de ejemplo. ¿Continuar?')) return;
    }
    state.warehouses = [
      { id: 1, name: "Almacén Centro", lat: -8.387488899497228, lng: -74.57146765017129, capacity: 350, active: true },
      { id: 2, name: "Almacén Este",   lat: -8.376917129425534, lng: -74.54262744885065, capacity: 300, active: true },
      { id: 3, name: "Almacén Norte",  lat: -8.369328406803264, lng: -74.58944599338959, capacity: 250, active: true },
      { id: 4, name: "Almacén Sur",    lat: -8.416475503623879, lng: -74.55825644760361, capacity: 200, active: true },
      { id: 5, name: "Almacén Oeste",  lat: -8.398528015372339, lng: -74.60325401286396, capacity: 150, active: true }
    ];
    state.demands = [
      { id: 1, name: "Cliente A", lat: -8.405097890147589, lng: -74.59082969968179, demand: 150, active: true },
      { id: 2, name: "Cliente B", lat: -8.392934512515076, lng: -74.54690524759773, demand: 140, active: true },
      { id: 3, name: "Cliente C", lat: -8.379794240187424, lng: -74.59298618079835, demand: 130, active: true },
      { id: 4, name: "Cliente D", lat: -8.41439529328327, lng: -74.58359814128603, demand: 120, active: true },
      { id: 5, name: "Cliente E", lat: -8.378923867209089, lng: -74.53206745023705, demand: 100, active: true },
      { id: 6, name: "Cliente F", lat: -8.364084769896177, lng: -74.5674301324994, demand: 110, active: true },
      { id: 7, name: "Cliente G", lat: -8.387892861206028, lng: -74.54197043841816, demand: 110, active: true },
      { id: 8, name: "Cliente H", lat: -8.403740526307175, lng: -74.55659416299257, demand: 120, active: true },
      { id: 9, name: "Cliente I", lat: -8.37860661715152, lng: -74.54216395688229, demand: 130, active: true },
      { id: 10, name: "Cliente J", lat: -8.383266277977745, lng: -74.5692223576555, demand: 140, active: true }
    ];
    state.nextWhId = 6; state.nextDzId = 11;
    renderWarehouses(); renderDemands(); redrawMarkers();
    state.lastResult = null;
    renderResultsEmpty(); resetKpis(); redrawRoutes();
    map.setView(DEFAULT_CENTER, DEFAULT_ZOOM);
  });

  /* ============== CLEAR ALL ============== */
  $('#btnClear').addEventListener('click', ()=>{
    if(!confirm('¿Eliminar todos los almacenes, zonas de demanda y resultados?')) return;
    state.warehouses = []; state.demands = []; state.nextWhId=1; state.nextDzId=1; state.lastResult=null;
    renderWarehouses(); renderDemands(); redrawMarkers(); redrawRoutes(); renderResultsEmpty(); resetKpis();
  });

  /* ============== EXPORT / IMPORT JSON ============== */
  $('#btnExport').addEventListener('click', ()=>{
    const payload = {
      warehouses: state.warehouses, demands: state.demands,
      settings: {
        circuitFactor: $('#circuitFactor').value,
        transportRate: $('#transportRate').value,
        splitMode: $('#splitMode').value
      }
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], {type:'application/json'});
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = 'red-logistica-datos.json';
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    URL.revokeObjectURL(url);
  });

  /**
   * Valida que el objeto importado tenga la forma esperada por la
   * aplicación antes de cargarlo: debe traer arreglos `warehouses` y
   * `demands`, y cada elemento debe tener los campos requeridos con tipos
   * correctos. Retorna { valid, errors } sin modificar nada — si valid es
   * false, el import se aborta por completo y no se cargan datos parciales.
   */
  function validateImportedPayload(data){
    const errors = [];
    if(!data || typeof data !== 'object' || Array.isArray(data)){
      return { valid:false, errors:['El archivo no contiene un objeto JSON válido.'] };
    }
    if(!Array.isArray(data.warehouses)){
      errors.push('Falta la clave "warehouses" (debe ser un arreglo), o no tiene el formato correcto.');
    }
    if(!Array.isArray(data.demands)){
      errors.push('Falta la clave "demands" (debe ser un arreglo), o no tiene el formato correcto.');
    }
    if(errors.length) return { valid:false, errors };

    const isFiniteNum = v => typeof v === 'number' && isFinite(v);
    data.warehouses.forEach((w, idx)=>{
      if(w == null || typeof w !== 'object'){ errors.push(`Almacén #${idx+1}: no es un objeto válido.`); return; }
      if(w.id === undefined) errors.push(`Almacén #${idx+1}: falta el campo "id".`);
      if(typeof w.name !== 'string' || !w.name.trim()) errors.push(`Almacén #${idx+1}: falta o es inválido el campo "name".`);
      if(!isFiniteNum(w.lat) || !isFiniteNum(w.lng)) errors.push(`Almacén #${idx+1} ("${w.name||'?'}"): faltan o son inválidas las coordenadas "lat"/"lng".`);
      if(!isFiniteNum(w.capacity) || w.capacity < 0) errors.push(`Almacén #${idx+1} ("${w.name||'?'}"): el campo "capacity" debe ser un número ≥ 0.`);
      if(typeof w.active !== 'boolean') errors.push(`Almacén #${idx+1} ("${w.name||'?'}"): falta o es inválido el campo booleano "active".`);
    });
    data.demands.forEach((d, idx)=>{
      if(d == null || typeof d !== 'object'){ errors.push(`Zona #${idx+1}: no es un objeto válido.`); return; }
      if(d.id === undefined) errors.push(`Zona #${idx+1}: falta el campo "id".`);
      if(typeof d.name !== 'string' || !d.name.trim()) errors.push(`Zona #${idx+1}: falta o es inválido el campo "name".`);
      if(!isFiniteNum(d.lat) || !isFiniteNum(d.lng)) errors.push(`Zona #${idx+1} ("${d.name||'?'}"): faltan o son inválidas las coordenadas "lat"/"lng".`);
      if(!isFiniteNum(d.demand) || d.demand < 0) errors.push(`Zona #${idx+1} ("${d.name||'?'}"): el campo "demand" debe ser un número ≥ 0.`);
      if(d.active !== undefined && typeof d.active !== 'boolean') errors.push(`Zona #${idx+1} ("${d.name||'?'}"): el campo "active" debe ser booleano.`);
    });
    return { valid: errors.length===0, errors };
  }

  $('#btnImportJsonTrigger').addEventListener('click', ()=> $('#importJsonFile').click());
  $('#importJsonFile').addEventListener('change', (e)=>{
    const file = e.target.files[0];
    if(!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      let data;
      try{
        data = JSON.parse(reader.result);
      } catch(err){
        showAlert(['danger'], ['El archivo no tiene un formato JSON válido para esta aplicación.']);
        return;
      }
      const check = validateImportedPayload(data);
      if(!check.valid){
        showAlert(['danger'], check.errors, 'El archivo no se cargó porque no tiene la estructura esperada.');
        return;
      }
      state.warehouses = data.warehouses;
      state.demands = data.demands.map(d=> Object.assign({}, d, { active: d.active !== false }));
      state.nextWhId = (Math.max(0,...state.warehouses.map(w=>w.id))||0) + 1;
      state.nextDzId = (Math.max(0,...state.demands.map(d=>d.id))||0) + 1;
      if(data.settings){
        const cf = parseFloat(data.settings.circuitFactor);
        const tr = parseFloat(data.settings.transportRate);
        $('#circuitFactor').value = (isFinite(cf) && cf > 0) ? cf : 1.15;
        $('#transportRate').value = (isFinite(tr) && tr >= 0) ? tr : 1.00;
        $('#splitMode').value = data.settings.splitMode === 'nosplit' ? 'nosplit' : 'split';
      }
      renderWarehouses(); renderDemands(); redrawMarkers();
      state.lastResult = null; renderResultsEmpty(); resetKpis(); redrawRoutes();
      if(state.warehouses.length || state.demands.length){
        const pts = [...state.warehouses, ...state.demands].map(p=>[p.lat,p.lng]);
        map.fitBounds(L.latLngBounds(pts), {padding:[40,40]});
      }
    };
    reader.readAsText(file);
    e.target.value = '';
  });

  /* ============== DISTANCE (haversine, fallback only) ============== */
  function haversineKm(a, b){
    const R = 6371;
    const toRad = d => d * Math.PI/180;
    const dLat = toRad(b.lat - a.lat), dLng = toRad(b.lng - a.lng);
    const s = Math.sin(dLat/2)**2 + Math.cos(toRad(a.lat))*Math.cos(toRad(b.lat))*Math.sin(dLng/2)**2;
    return R * 2 * Math.atan2(Math.sqrt(s), Math.sqrt(1-s));
  }

  /* ============== OSRM REAL ROUTING ============== */
  async function fetchOsrmRoute(a, b, signal){
    const url = `https://router.project-osrm.org/route/v1/driving/${a.lng},${a.lat};${b.lng},${b.lat}?overview=full&geometries=geojson`;
    const resp = await fetch(url, { signal });
    if(!resp.ok) throw new Error('osrm http error');
    const data = await resp.json();
    if(!data.routes || !data.routes[0]) throw new Error('sin ruta');
    return {
      km: data.routes[0].distance/1000,
      coords: data.routes[0].geometry.coordinates.map(c=>[c[1],c[0]])
    };
  }

  function setRoutingStatus(text, opts){
    const box = $('#routingStatus');
    const cancelBtn = $('#btnCancelOptimization');
    if(text){
      $('#routingStatusText').textContent = text;
      $('#routingStatusEta').textContent = (opts && opts.eta) ? opts.eta : '';
      $('#progressBarFill').style.width = (opts && typeof opts.pct === 'number') ? Math.min(100,Math.max(0,opts.pct))+'%' : '0%';
      cancelBtn.style.display = (opts && opts.cancellable===false) ? 'none' : '';
      box.classList.add('show');
    } else {
      box.classList.remove('show');
      $('#progressBarFill').style.width = '0%';
      $('#routingStatusEta').textContent = '';
    }
  }

  function fmtEtaSeconds(sec){
    if(!isFinite(sec) || sec <= 0) return '';
    if(sec < 60) return `~${Math.ceil(sec)} s restantes`;
    return `~${Math.ceil(sec/60)} min restantes`;
  }

  /**
   * Construye la matriz de distancias REALES por calle (OSRM) entre cada
   * almacén y cada zona de demanda. Limita la concurrencia a 2 peticiones
   * simultáneas, reutiliza distanceCache para pares ya calculados en una
   * ejecución previa, y permite cancelar mediante AbortController.
   * Si OSRM falla para un par, cae a Haversine * r y marca esa celda como
   * estimated:true (sin coordenadas de ruta reales), contabilizando el fallo.
   * Retorna { matrix, estimatedCount, cachedCount, cancelled }.
   */
  async function buildDistanceMatrix(warehouses, demands, safetyFactor, abortController){
    const m = warehouses.length, n = demands.length;
    const matrix = Array.from({length:m}, ()=> new Array(n).fill(null));
    const jobs = [];
    for(let i=0;i<m;i++){
      for(let j=0;j<n;j++){
        const cacheKey = distanceCacheKey(warehouses[i], demands[j]);
        const cached = distanceCache.get(cacheKey);
        if(cached){ matrix[i][j] = cached; }
        else { jobs.push({i,j,cacheKey}); }
      }
    }
    const total = jobs.length;
    const cachedCount = (m*n) - total;
    let done = 0;
    let estimatedCount = 0;
    const startTime = performance.now();
    let cancelled = false;
    let cursor = 0;
    const CONCURRENCY = 1;
    const MIN_INTERVAL_MS = 1000;
    let lastRequestAt = 0;

    if(total > 0){
      setRoutingStatus(
        `Solicitando ruta 0/${total} (1 petición/seg)${cachedCount?` (${cachedCount} ya en caché)`:''}…`,
        { pct:0, eta: fmtEtaSeconds(total * MIN_INTERVAL_MS / 1000) }
      );
    }

    async function worker(){
      while(cursor < jobs.length){
        if(abortController && abortController.signal.aborted){ cancelled = true; return; }
        const {i,j,cacheKey} = jobs[cursor++];
        const wh = warehouses[i], dz = demands[j];
        const wait = lastRequestAt + MIN_INTERVAL_MS - performance.now();
        if(wait > 0){
          const etaSec = ((total - done) * MIN_INTERVAL_MS) / 1000;
          setRoutingStatus(
            `Respetando límite de 1 petición/seg… (${done}/${total})`,
            { pct: (done/total)*100, eta: fmtEtaSeconds(etaSec) }
          );
          await new Promise(res => setTimeout(res, wait));
          if(abortController && abortController.signal.aborted){ cancelled = true; return; }
        }
        lastRequestAt = performance.now();
        let cell;
        try{
          const route = await fetchOsrmRoute(wh, dz, abortController ? abortController.signal : undefined);
          cell = { km: route.km, estimated:false, routeCoords: route.coords };
        } catch(err){
          if(err && err.name === 'AbortError'){ cancelled = true; return; }
          console.warn('OSRM falló para el par almacén/zona, usando Haversine aproximado:', wh.name, '->', dz.name, err);
          cell = { km: haversineKm(wh, dz) * safetyFactor, estimated:true, routeCoords:null };
          estimatedCount++;
        }
        matrix[i][j] = cell;
        distanceCache.set(cacheKey, cell);
        done++;
        const elapsed = (performance.now() - startTime) / 1000;
        const rate = done / Math.max(elapsed, 0.001);
        const remaining = total - done;
        const eta = fmtEtaSeconds(remaining / Math.max(rate, 0.001));
        const pct = (done/total)*100;
        setRoutingStatus(`Solicitando ruta ${done}/${total}…`, {pct, eta});
      }
    }
    await Promise.all(Array.from({length:Math.min(CONCURRENCY, jobs.length||1)}, worker));
    return { matrix, estimatedCount, cachedCount, cancelled };
  }

  /* ============== TRANSPORTATION PROBLEM SOLVER (VAM + MODI) ============== */
  const TP_EPS = 1e-7;

  /* Fase 1: Método de Aproximación de Vogel (VAM) — solución básica inicial */
  function vamInitialSolution(supplyArr, demandArr, costs){
    const m = supplyArr.length, n = demandArr.length;
    const supply = supplyArr.slice(), demand = demandArr.slice();
    const rowDone = new Array(m).fill(false);
    const colDone = new Array(n).fill(false);
    const X = Array.from({length:m}, ()=> new Array(n).fill(0));
    const basic = new Set();
    let remainingRows = m, remainingCols = n;

    function allocate(i, j){
      const amt = Math.min(supply[i], demand[j]);
      X[i][j] += amt;
      basic.add(i+','+j);
      supply[i] -= amt;
      demand[j] -= amt;
      if(supply[i] <= TP_EPS && !rowDone[i]){ rowDone[i]=true; remainingRows--; }
      if(demand[j] <= TP_EPS && !colDone[j]){ colDone[j]=true; remainingCols--; }
    }

    while(remainingRows > 0 && remainingCols > 0){
      if(remainingRows === 1 || remainingCols === 1){
        for(let i=0;i<m;i++){
          if(rowDone[i]) continue;
          for(let j=0;j<n;j++){
            if(colDone[j]) continue;
            if(supply[i] <= TP_EPS || demand[j] <= TP_EPS) continue;
            allocate(i, j);
          }
        }
        break;
      }
      let bestPenalty = -Infinity, bestType = null, bestIdx = -1;
      for(let i=0;i<m;i++){
        if(rowDone[i]) continue;
        const vals = [];
        for(let j=0;j<n;j++) if(!colDone[j]) vals.push(costs[i][j]);
        vals.sort((a,b)=>a-b);
        const penalty = vals.length >= 2 ? (vals[1]-vals[0]) : vals[0];
        if(penalty > bestPenalty){ bestPenalty = penalty; bestType = 'row'; bestIdx = i; }
      }
      for(let j=0;j<n;j++){
        if(colDone[j]) continue;
        const vals = [];
        for(let i=0;i<m;i++) if(!rowDone[i]) vals.push(costs[i][j]);
        vals.sort((a,b)=>a-b);
        const penalty = vals.length >= 2 ? (vals[1]-vals[0]) : vals[0];
        if(penalty > bestPenalty){ bestPenalty = penalty; bestType = 'col'; bestIdx = j; }
      }
      let ci, cj;
      if(bestType === 'row'){
        ci = bestIdx;
        let bc = Infinity;
        for(let j=0;j<n;j++) if(!colDone[j] && costs[ci][j] < bc){ bc = costs[ci][j]; cj = j; }
      } else {
        cj = bestIdx;
        let bc = Infinity;
        for(let i=0;i<m;i++) if(!rowDone[i] && costs[i][cj] < bc){ bc = costs[i][cj]; ci = i; }
      }
      allocate(ci, cj);
    }
    return { X, basic };
  }

  /* Camino único entre dos nodos de un árbol de expansión (para el ciclo de MODI) */
  function tpFindPath(adj, start, target){
    const parent = new Map();
    const visited = new Set([start]);
    const queue = [start];
    while(queue.length){
      const node = queue.shift();
      if(node === target) break;
      for(const nb of adj[node]){
        if(visited.has(nb)) continue;
        visited.add(nb);
        parent.set(nb, node);
        queue.push(nb);
      }
    }
    const path = [target];
    let cur = target;
    while(cur !== start){ cur = parent.get(cur); path.unshift(cur); }
    return path;
  }

  /* Fase 2: Método MODI (u-v) — una iteración de mejora sobre la base actual */
  function modiStep(costs, basicSet, m, n){
    const basic = new Set(basicSet);

    // Asegura árbol de expansión completo (m+n-1 aristas) para poder calcular u,v
    // incluso si la solución de VAM resultó degenerada.
    const parent = Array.from({length:m+n}, (_,i)=>i);
    function find(x){ while(parent[x]!==x){ parent[x]=parent[parent[x]]; x=parent[x]; } return x; }
    function union(a,b){ const ra=find(a), rb=find(b); if(ra!==rb){ parent[ra]=rb; return true; } return false; }
    let edges = 0;
    basic.forEach(key=>{ const [i,j]=key.split(',').map(Number); if(union(i, m+j)) edges++; });
    for(let i=0;i<m && edges<m+n-1;i++){
      for(let j=0;j<n && edges<m+n-1;j++){
        const key = i+','+j;
        if(basic.has(key)) continue;
        if(union(i, m+j)){ basic.add(key); edges++; }
      }
    }

    const adj = Array.from({length:m+n}, ()=>[]);
    basic.forEach(key=>{
      const [i,j] = key.split(',').map(Number);
      adj[i].push(m+j);
      adj[m+j].push(i);
    });

    const u = new Array(m).fill(null), v = new Array(n).fill(null);
    u[0] = 0;
    const visited = new Array(m+n).fill(false);
    visited[0] = true;
    const queue = [0];
    while(queue.length){
      const node = queue.shift();
      for(const nb of adj[node]){
        if(visited[nb]) continue;
        visited[nb] = true;
        if(node < m){ const i=node, j=nb-m; v[j] = costs[i][j]-u[i]; }
        else { const j=node-m, i=nb; u[i] = costs[i][j]-v[j]; }
        queue.push(nb);
      }
    }
    for(let i=0;i<m;i++) if(u[i]===null) u[i]=0;
    for(let j=0;j<n;j++) if(v[j]===null) v[j]=0;

    let enter = null, bestVal = -1e-6;
    for(let i=0;i<m;i++){
      for(let j=0;j<n;j++){
        const key = i+','+j;
        if(basic.has(key)) continue;
        const reduced = costs[i][j] - u[i] - v[j];
        if(reduced < bestVal){ bestVal = reduced; enter = [i,j]; }
      }
    }
    if(!enter) return { optimal:true, basic };

    const [ei, ej] = enter;
    const path = tpFindPath(adj, ei, m+ej);
    const numPathEdges = path.length - 1;
    const loopCells = [[ei, ej, 1]];
    for(let k=0;k<numPathEdges;k++){
      const a = path[k], b = path[k+1];
      let i, j;
      if(a < m){ i = a; j = b-m; } else { i = b; j = a-m; }
      const sign = ((numPathEdges - k) % 2 === 1) ? -1 : 1;
      loopCells.push([i, j, sign]);
    }
    return { optimal:false, basic, loopCells, enter };
  }

  /* Orquesta VAM (fase 1) + MODI (fase 2) hasta el óptimo global */
  function solveTransportationBalanced(costs, supply, demand){
    const m = supply.length, n = demand.length;
    let { X, basic } = vamInitialSolution(supply, demand, costs);
    const MAX_ITER = 400;
    for(let iter=0; iter<MAX_ITER; iter++){
      const step = modiStep(costs, basic, m, n);
      basic = step.basic;
      if(step.optimal) break;
      let theta = Infinity;
      step.loopCells.forEach(([i,j,sign])=>{ if(sign===-1) theta = Math.min(theta, X[i][j]); });
      step.loopCells.forEach(([i,j,sign])=>{ X[i][j] += sign*theta; });
      let leaveKey = null;
      for(const [i,j,sign] of step.loopCells){
        if(sign===-1 && Math.abs(X[i][j]) < 1e-7){ leaveKey = i+','+j; X[i][j] = 0; break; }
      }
      if(leaveKey) basic.delete(leaveKey);
      basic.add(step.enter[0]+','+step.enter[1]);
    }
    return X;
  }

  /**
   * Resuelve el Problema de Transporte con la matriz de costos (distancias
   * reales * tarifa), las capacidades de almacenes y las demandas de zonas.
   * Balancea con una fila/columna ficticia (costo 0) cuando oferta y
   * demanda totales no coinciden, y retorna la matriz de asignación óptima
   * recortada al tamaño real (sin la fila/columna ficticia).
   */
  function solveTransportationProblem(costs, supply, demand){
    const m = supply.length, n = demand.length;
    const totalSupply = supply.reduce((a,b)=>a+b,0);
    const totalDemand = demand.reduce((a,b)=>a+b,0);
    let S = supply.slice(), D = demand.slice();
    let C = costs.map(row=>row.slice());
    let dummyRow=false, dummyCol=false;
    if(totalSupply > totalDemand + TP_EPS){
      D.push(totalSupply - totalDemand);
      C.forEach(row=>row.push(0));
      dummyCol = true;
    } else if(totalDemand > totalSupply + TP_EPS){
      S.push(totalDemand - totalSupply);
      C.push(new Array(n).fill(0));
      dummyRow = true;
    }
    const X = solveTransportationBalanced(C, S, D);
    const M = S.length, N = D.length;
    const realM = dummyRow ? M-1 : M;
    const realN = dummyCol ? N-1 : N;
    return X.slice(0, realM).map(row=> row.slice(0, realN));
  }

  /**
   * Heurística inicial estricta para el modo "no dividir" (sin fraccionar
   * ninguna zona): ordena las zonas de mayor a menor demanda y asigna cada
   * una al almacén factible de menor costo cuya capacidad restante alcance
   * para TODA la demanda de la zona. Si ningún almacén cabe completo, la
   * zona queda sin asignar (0 unidades, sin costo). Sirve como cota
   * superior inicial (solución factible de partida) para el branch & bound.
   */
  function greedyNoSplitAssignment(costMatrix, capacities, demands){
    const m = capacities.length, n = demands.length;
    const remCap = capacities.slice();
    const allocation = Array.from({length:m}, ()=> new Array(n).fill(0));
    const assignedTo = new Array(n).fill(-1);
    const order = demands.map((d,j)=>j).sort((a,b)=> demands[b]-demands[a]);
    let totalCost = 0;
    order.forEach(j=>{
      let best = -1, bestCost = Infinity;
      for(let i=0;i<m;i++){
        if(demands[j] <= remCap[i] + TP_EPS && costMatrix[i][j] < bestCost){
          bestCost = costMatrix[i][j]; best = i;
        }
      }
      if(best >= 0){
        allocation[best][j] = demands[j];
        remCap[best] -= demands[j];
        assignedTo[j] = best;
        totalCost += bestCost;
      }
    });
    return { allocation, totalCost, assignedTo };
  }

  /**
   * Algoritmo EXACTO de Branch & Bound para el problema de asignación con
   * capacidad en modo "no dividir".
   *
   * Formulación: x[i][j] ∈ {0,1} = 1 si la zona j se asigna COMPLETA al
   * almacén i. Minimiza Σ c[i][j]*x[i][j] sujeto a Σ_i x[i][j] = 1 (cada
   * zona a un solo almacén) y Σ_j demanda[j]*x[i][j] ≤ capacidad[i].
   *
   * Regla de negocio estricta: una zona SOLO puede asignarse a un almacén
   * si demanda[j] ≤ capacidad_restante[i] (capacidad total, no parcial).
   * Si en un estado del árbol ningún almacén tiene esa capacidad, la zona
   * se deja forzosamente sin asignar (0 unidades, sin costo) — nunca se le
   * imputa costo de transporte ni aparece como "parcial".
   *
   * - Orden de exploración: zonas de mayor a menor demanda (poda más rápida).
   * - Cota superior inicial: greedyNoSplitAssignment.
   * - Cota inferior: para cada zona restante, el menor c[i][j] entre todos
   *   los almacenes ignorando capacidad (cota válida y admisible en el
   *   caso típico donde la capacidad total alcanza para toda la demanda).
   * - Poda: si costoAcumulado + cotaInferiorRestante ≥ mejorCosto, se
   *   descarta la rama.
   * - Poda por capacidad: sólo se exploran almacenes con capacidad
   *   restante suficiente para la zona completa.
   * - Si hay más de 20 zonas, se aplica un límite de tiempo (por defecto
   *   3 s) y se devuelve la mejor solución encontrada hasta ese momento,
   *   marcada como aproximada por tiempo.
   *
   * onProgress(info) se invoca periódicamente para poder reflejar avance
   * en la interfaz sin congelar el hilo principal (se cede el hilo cada
   * cierto número de nodos explorados).
   */
  async function solveExactAssignment(costMatrix, capacities, demands, timeLimitMs, onProgress){
    const m = capacities.length, n = demands.length;
    timeLimitMs = timeLimitMs || 3000;
    const useTimeLimit = n > 20;
    const startTime = performance.now();

    const order = demands.map((d,j)=>j).sort((a,b)=> demands[b]-demands[a]);

    // Cota superior inicial (solución factible de partida)
    const seed = greedyNoSplitAssignment(costMatrix, capacities, demands);
    let bestCost = seed.totalCost;
    let bestAssign = seed.assignedTo.slice();

    // Cota inferior: menor costo posible por zona, ignorando capacidad
    const minCostPerZone = new Array(n).fill(0);
    for(let j=0;j<n;j++){
      let mc = Infinity;
      for(let i=0;i<m;i++) if(costMatrix[i][j] < mc) mc = costMatrix[i][j];
      minCostPerZone[j] = isFinite(mc) ? mc : 0;
    }
    const suffixLowerBound = new Array(n+1).fill(0);
    for(let k=n-1;k>=0;k--) suffixLowerBound[k] = suffixLowerBound[k+1] + minCostPerZone[order[k]];

    let timedOut = false;
    let nodesVisited = 0;
    const assignedTo = new Array(n).fill(-1);
    const remCap = capacities.slice();

    async function backtrack(k, accCost){
      if(timedOut) return;
      nodesVisited++;
      if(nodesVisited % 500 === 0){
        if(useTimeLimit && (performance.now() - startTime) > timeLimitMs){ timedOut = true; return; }
        if(onProgress) onProgress({ nodesVisited, processedZones:k, totalZones:n, bestCost });
        await new Promise(res=> setTimeout(res, 0)); // cede el hilo para pintar la UI
      }
      if(accCost + suffixLowerBound[k] >= bestCost - TP_EPS) return; // poda por cota
      if(k === n){
        if(accCost < bestCost - TP_EPS){ bestCost = accCost; bestAssign = assignedTo.slice(); }
        return;
      }
      const j = order[k];
      const candidates = [];
      for(let i=0;i<m;i++){
        if(demands[j] <= remCap[i] + TP_EPS) candidates.push({ i, cost: costMatrix[i][j] });
      }
      if(candidates.length === 0){
        // Ningún almacén tiene capacidad suficiente: la zona queda sin servir, sin costo.
        assignedTo[j] = -1;
        await backtrack(k+1, accCost);
        return;
      }
      candidates.sort((a,b)=> a.cost - b.cost); // explorar primero el más barato mejora la poda
      for(const c of candidates){
        remCap[c.i] -= demands[j];
        assignedTo[j] = c.i;
        await backtrack(k+1, accCost + c.cost);
        remCap[c.i] += demands[j];
        if(timedOut) return;
      }
    }

    await backtrack(0, 0);

    const allocation = Array.from({length:m}, ()=> new Array(n).fill(0));
    bestAssign.forEach((i,j)=>{ if(i>=0) allocation[i][j] = demands[j]; });

    return { allocation, totalCost: bestCost, optimal: !timedOut, timedOut, nodesVisited, assignedTo: bestAssign };
  }

  /* ============== VALIDACIÓN NUMÉRICA EN VIVO (feedback inmediato en campos) ============== */
  function wireLiveNumericValidation(inputId, warnId, predicate){
    const input = $('#'+inputId), warn = $('#'+warnId);
    function check(){
      const v = parseFloat(input.value);
      const ok = predicate(v);
      input.classList.toggle('field-invalid', !ok);
      warn.classList.toggle('show', !ok);
    }
    input.addEventListener('input', check);
    check();
  }
  wireLiveNumericValidation('circuitFactor', 'circuitFactorWarn', v=> isFinite(v) && v > 0);
  wireLiveNumericValidation('transportRate', 'transportRateWarn', v=> isFinite(v) && v >= 0);

  /* ============== VALIDACIÓN NUMÉRICA DE PARÁMETROS GLOBALES ============== */
  /**
   * Verifica que el factor de seguridad y la tarifa sean números válidos y
   * no negativos (el factor de seguridad, además, no puede ser cero o
   * negativo porque multiplica distancias). Retorna { valid, r, rate,
   * messages } — si valid es false, no se debe ejecutar la optimización.
   */
  function validateGlobalParams(){
    const messages = [];
    const rRaw = $('#circuitFactor').value;
    const rateRaw = $('#transportRate').value;
    let r = parseFloat(rRaw);
    let rate = parseFloat(rateRaw);
    if(isNaN(r) || r <= 0){
      messages.push('El factor de seguridad (r) debe ser un número mayor que 0.');
      r = 1;
    }
    if(isNaN(rate) || rate < 0){
      messages.push('La tarifa ($/unidad·km) debe ser un número mayor o igual a 0.');
      rate = 0;
    }
    return { valid: messages.length===0, r, rate, messages };
  }

  /**
   * Revisa el estado actual de almacenes y zonas de demanda en busca de
   * capacidades o demandas negativas o inválidas (por ejemplo, tras
   * importar un archivo JSON manipulado externamente). No modifica los
   * datos; sólo informa para que el usuario pueda corregirlos.
   */
  function validateNetworkNumbers(){
    const messages = [];
    state.warehouses.forEach(w=>{
      if(!isFinite(w.capacity) || w.capacity < 0){
        messages.push(`El almacén "${w.name}" tiene una capacidad inválida (${w.capacity}).`);
      }
    });
    state.demands.forEach(d=>{
      if(!isFinite(d.demand) || d.demand < 0){
        messages.push(`La zona "${d.name}" tiene una demanda inválida (${d.demand}).`);
      }
    });
    return { valid: messages.length===0, messages };
  }

  /* ============== ALGORITHM (Transporte óptimo con distancias reales) ============== */
  async function runOptimization(){
    const activeWarehouses = state.warehouses.filter(w=>w.active);
    const activeDemands = state.demands.filter(d=>d.active !== false);
    if(activeWarehouses.length === 0){
      showAlert(['danger'], ['No hay almacenes activos en la red. Agrega al menos un almacén activo antes de ejecutar la optimización.']);
      return;
    }
    if(activeDemands.length === 0){
      showAlert(['danger'], ['No hay zonas de demanda activas. Activa o agrega al menos una zona antes de ejecutar la optimización.']);
      return;
    }

    const paramCheck = validateGlobalParams();
    if(!paramCheck.valid){
      showAlert(['danger'], paramCheck.messages, 'Corrige los parámetros antes de ejecutar la optimización.');
      return;
    }
    const netCheck = validateNetworkNumbers();
    if(!netCheck.valid){
      showAlert(['danger'], netCheck.messages, 'Hay valores numéricos inválidos en la red.');
      return;
    }

    const r = paramCheck.r;
    const rate = paramCheck.rate;
    const allowSplit = $('#splitMode').value === 'split';
    const demands = activeDemands;

    const btnRun = $('#btnRun');
    btnRun.disabled = true;

    const abortController = new AbortController();
    currentOptimizationAbort = abortController;
    const cancelBtn = $('#btnCancelOptimization');
    const onCancelClick = ()=> abortController.abort();
    cancelBtn.addEventListener('click', onCancelClick);

    try{
      setRoutingStatus('Solicitando rutas…', {pct:0});
      const { matrix: distMatrix, estimatedCount, cachedCount, cancelled } =
        await buildDistanceMatrix(activeWarehouses, demands, r, abortController);

      if(cancelled || abortController.signal.aborted){
        setRoutingStatus(null);
        showAlert(['warn'], ['La optimización fue cancelada por el usuario. No se modificaron los resultados anteriores.']);
        return;
      }

      const m = activeWarehouses.length, n = demands.length;
      const costMatrix = Array.from({length:m}, (_,i)=> Array.from({length:n}, (_,j)=>{
        const A = distMatrix[i][j].km * rate * r;
        return A + (demands[j].demand * 0.01 * A);
      }));
      const capacities = activeWarehouses.map(w=>w.capacity);
      const demandQty = demands.map(d=>d.demand);

      let finalAlloc, exactMeta = null;
      if(allowSplit){
        setRoutingStatus('Resolviendo problema de transporte (VAM + MODI)…', {pct:100, cancellable:false});
        await new Promise(res=> setTimeout(res, 0));
        finalAlloc = solveTransportationProblem(costMatrix, capacities, demandQty);
      } else {
        const timeLimit = n > 20 ? 3000 : 30000;
        const result = await solveExactAssignment(costMatrix, capacities, demandQty, timeLimit, (info)=>{
          setRoutingStatus(`Optimizando asignación exacta… (zonas procesadas: ${info.processedZones}/${info.totalZones})`, {pct:100, cancellable:false});
        });
        finalAlloc = result.allocation;
        exactMeta = result;
      }

      const assignments = [];
      let totalCost = 0, totalDist = 0, totalDemand = 0, totalSatisfied = 0;
      const inconsistencies = [];

      demands.forEach((dz, j)=>{
        totalDemand += dz.demand;
        let remaining = dz.demand;
        const parts = [];
        activeWarehouses.forEach((wh, i)=>{
          const units = finalAlloc[i][j];
          if(units > TP_EPS){
            const cell = distMatrix[i][j];
            const A = cell.km * rate * r;
            const cost = A + (units * 0.01 * A);
            parts.push({
              warehouseId: wh.id, warehouseName: wh.name, units, dist: cell.km, cost,
              estimated: cell.estimated, routeCoords: cell.routeCoords
            });
            remaining -= units;
            totalCost += cost;
            totalDist += cell.km * units;
          }
        });
        remaining = Math.max(0, remaining);
        totalSatisfied += (dz.demand - remaining);

        let status = 'ok';
        if(remaining > TP_EPS && parts.length > 0) status = 'partial';
        if(parts.length === 0 && dz.demand > TP_EPS) status = 'fail';

        if(status !== 'ok'){
          const reason = (!allowSplit && status==='fail')
            ? 'ningún almacén tiene capacidad suficiente para atender la zona completa (política de no dividir).'
            : 'falta de capacidad en la red.';
          inconsistencies.push(`${dz.name}: ${remaining.toLocaleString('es-PE')} unidades sin asignar por ${reason}`);
        }

        assignments.push({ demand: dz, parts, unassigned: remaining, status });
      });

      const warehouseUsage = activeWarehouses.map((w, i) => {
        const used = finalAlloc[i].reduce((s,u)=>s+u, 0);
        return { id: w.id, name: w.name, capacity: w.capacity, used, remaining: w.capacity - used };
      });

      state.lastResult = { assignments, totalCost, totalDist, totalDemand, totalSatisfied, warehouseUsage };

      renderResults();
      renderKpis();
      renderUtilization();
      redrawMarkers();
      redrawRoutes();

      if(exactMeta){
        if(exactMeta.optimal){
          console.info(`Asignación exacta óptima encontrada (nodos explorados: ${exactMeta.nodesVisited}).`);
        } else {
          inconsistencies.push('El límite de tiempo para la búsqueda exacta se agotó; se muestra la mejor solución "no dividir" encontrada hasta el momento (posiblemente no óptima).');
        }
      }
      if(estimatedCount > 0){
        const totalRoutes = m*n;
        inconsistencies.push(`${estimatedCount} de ${totalRoutes} rutas se calcularon con distancia aproximada (línea recta) porque OSRM no pudo resolverlas.`);
      }

      if(inconsistencies.length > 0){
        showAlert(['warn'], inconsistencies, exactMeta && !exactMeta.optimal ? 'Optimización completada con advertencias' : 'Algunas zonas de demanda superan la capacidad disponible de la red.');
      } else if(totalDemand > activeWarehouses.reduce((s,w)=>s+w.capacity,0)){
        showAlert(['warn'], ['La demanda total de la red supera la capacidad total instalada.']);
      }
    } catch(err){
      if(err && err.name === 'AbortError'){
        showAlert(['warn'], ['La optimización fue cancelada por el usuario.']);
      } else {
        showAlert(['danger'], ['Ocurrió un error inesperado al calcular la asignación óptima: ' + (err && err.message ? err.message : err)]);
      }
    } finally {
      setRoutingStatus(null);
      btnRun.disabled = false;
      cancelBtn.removeEventListener('click', onCancelClick);
      currentOptimizationAbort = null;
    }
  }

  $('#btnRun').addEventListener('click', runOptimization);

  /* ============== RESULTS RENDERING ============== */
  function renderResultsEmpty(){
    $('#resultsTbody').innerHTML = '<tr class="empty-row"><td colspan="5">Sin resultados todavía. Ejecuta la optimización.</td></tr>';
    $('#utilizationList').innerHTML = '<div class="hint">Sin datos todavía.</div>';
    setRoutingStatus(null);
  }

  function resetKpis(){
    $('#kpiCost').textContent = '$ 0';
    $('#kpiDist').textContent = '0';
    $('#kpiSat').innerHTML = '0<small>%</small>';
    $('#kpiSaturated').textContent = '0';
    ['kpiCostCard','kpiDistCard','kpiSatCard','kpiSatCountCard'].forEach(id=>{
      $('#'+id).classList.remove('warn','danger');
    });
  }

  function renderResults(){
    const res = state.lastResult;
    const tbody = $('#resultsTbody');
    tbody.innerHTML = '';
    if(!res || res.assignments.length===0){
      renderResultsEmpty();
      return;
    }
    res.assignments.forEach(a=>{
      const tr = document.createElement('tr');
      const warehousesTxt = a.parts.length
        ? a.parts.map(p=> `${escapeHtml(p.warehouseName)} (${fmtNum(p.units,0)})`).join(' + ')
        : '—';
      const distTxt = a.parts.length
        ? a.parts.map(p=> fmtNum(p.dist,2) + (p.estimated?'<span class="approx-tag">~</span>':'')).join(' / ')
        : '—';
      const costTxt = a.parts.length ? fmtMoney(a.parts.reduce((s,p)=>s+p.cost,0)) : '—';
      let statusHtml;
      if(a.status==='ok') statusHtml = '<span class="assign-status assign-ok">Asignada</span>';
      else if(a.status==='partial') statusHtml = `<span class="assign-status assign-partial">Parcial (${fmtNum(a.unassigned,0)})</span>`;
      else statusHtml = '<span class="assign-status assign-fail">Sin capacidad</span>';

      tr.innerHTML = `
        <td class="name-cell">${escapeHtml(a.demand.name)}</td>
        <td>${warehousesTxt}</td>
        <td>${distTxt}</td>
        <td>${costTxt}</td>
        <td>${statusHtml}</td>`;
      tbody.appendChild(tr);
    });
  }

  function renderKpis(){
    const res = state.lastResult;
    if(!res) { resetKpis(); return; }
    $('#kpiCost').textContent = fmtMoney(res.totalCost);
    $('#kpiDist').textContent = fmtNum(res.totalDist, 1);
    const satPct = res.totalDemand > 0 ? (res.totalSatisfied / res.totalDemand * 100) : 0;
    $('#kpiSat').innerHTML = fmtNum(satPct,1) + '<small>%</small>';
    const saturatedCount = res.warehouseUsage.filter(w => w.capacity>0 && (w.used/w.capacity) >= 0.999).length;
    $('#kpiSaturated').textContent = saturatedCount;

    $('#kpiSatCard').classList.toggle('warn', satPct < 100 && satPct >= 90);
    $('#kpiSatCard').classList.toggle('danger', satPct < 90);
    $('#kpiSatCountCard').classList.toggle('warn', saturatedCount > 0);
  }

  function renderUtilization(){
    const res = state.lastResult;
    const box = $('#utilizationList');
    if(!res || res.warehouseUsage.length===0){
      box.innerHTML = '<div class="hint">Sin datos todavía.</div>';
      return;
    }
    box.innerHTML = '';
    res.warehouseUsage.forEach(w=>{
      const pct = w.capacity>0 ? (w.used/w.capacity*100) : 0;
      let barColor = 'var(--ok)';
      if(pct >= 100) barColor = 'var(--danger)';
      else if(pct >= 80) barColor = 'var(--warn)';
      const idx = state.warehouses.findIndex(x=>x.id===w.id);
      const row = document.createElement('div');
      row.className = 'warehouse-util-row';
      row.innerHTML = `
        <div class="wu-name"><span class="swatch" style="background:${colorFor(idx)}"></span>${escapeHtml(w.name)}</div>
        <div class="wu-bar-col"><div class="util-bar-wrap"><div class="util-bar" style="width:${Math.min(pct,100)}%; background:${barColor};"></div></div></div>
        <div class="wu-pct">${fmtNum(pct,1)}%</div>`;
      box.appendChild(row);
    });
  }

  /* ============== ALERT MODAL ============== */
  function showAlert(kinds, messages, headline){
    const isDanger = kinds.includes('danger');
    const box = $('#alertBody');
    box.innerHTML = `
      <div class="alert-box ${isDanger?'':'warn'}">
        <span>${isDanger?ICONS.danger:ICONS.warn}</span>
        <div>
          ${headline ? `<div style="font-weight:600; margin-bottom:6px;">${escapeHtml(headline)}</div>` : ''}
          <ul class="alert-list">${messages.map(m=>`<li>${escapeHtml(m)}</li>`).join('')}</ul>
        </div>
      </div>`;
    openModal('modalAlert');
  }

  /* ============== MAP MARKERS / ROUTES DRAWING ============== */
  function buildWhTooltip(wh, idx){
    const usage = state.lastResult ? state.lastResult.warehouseUsage.find(u=>u.id===wh.id) : null;
    const pct = usage && wh.capacity>0 ? (usage.used/wh.capacity*100) : 0;
    const cost = usage ? state.lastResult.assignments.reduce((s,a)=> s + a.parts.filter(p=>p.warehouseId===wh.id).reduce((s2,p)=>s2+p.cost,0), 0) : 0;
    return `<div class="tt-title">${escapeHtml(wh.name)}</div>
      <div class="tt-row">Capacidad: ${fmtNum(wh.capacity,0)}</div>
      ${usage ? `<div class="tt-row">Usado: ${fmtNum(usage.used,0)} (${fmtNum(pct,1)}% utilización)</div>` : ''}
      ${usage ? `<div class="tt-row">Costo de transporte: ${fmtMoney(cost)}</div>` : ''}
      <div class="tt-row">${wh.active?'Activo':'Inactivo'}</div>`;
  }
  function buildDzTooltip(dz){
    const a = state.lastResult ? state.lastResult.assignments.find(x=>x.demand.id===dz.id) : null;
    const cost = a ? a.parts.reduce((s,p)=>s+p.cost,0) : 0;
    return `<div class="tt-title">${escapeHtml(dz.name)}</div>
      <div class="tt-row">Demanda: ${fmtNum(dz.demand,0)}</div>
      ${a ? `<div class="tt-row">Asignado a: ${a.parts.map(p=>p.warehouseName).join(', ')||'—'}</div>` : ''}
      ${a && a.parts.length ? `<div class="tt-row">Costo de transporte: ${fmtMoney(cost)}</div>` : ''}
      <div class="tt-row">${dz.active!==false?'Activo':'Inactivo'}</div>`;
  }

  function redrawMarkers(){
    whMarkersLayer.clearLayers();
    dzMarkersLayer.clearLayers();
    state.warehouses.forEach((wh, idx)=>{
      const marker = L.marker([wh.lat, wh.lng], {icon: warehouseIcon(colorFor(idx), wh.active)});
      marker.bindTooltip(buildWhTooltip(wh, idx), {direction:'top', offset:[0,-8], className:'lf-tt'});
      marker.addTo(whMarkersLayer);
    });
    state.demands.forEach(dz=>{
      const isActive = dz.active !== false;
      let color = '#7f92ab';
      if(isActive && state.lastResult){
        const a = state.lastResult.assignments.find(x=>x.demand.id===dz.id);
        if(a){
          if(a.status==='fail') color = '#0d1520';
          else if(a.parts.length===1){ const idx = state.warehouses.findIndex(w=>w.id===a.parts[0].warehouseId); color = colorFor(idx); }
          else if(a.parts.length>1) color = '#dbe4f0';
        }
      }
      const marker = L.marker([dz.lat, dz.lng], {icon: demandIcon(color, isActive)});
      marker.bindTooltip(buildDzTooltip(dz), {direction:'top', offset:[0,-6], className:'lf-tt'});
      marker.addTo(dzMarkersLayer);
    });
    renderLegend();
  }

  function redrawRoutes(){
    routesLayer.clearLayers();
    if(!state.lastResult) return;
    state.lastResult.assignments.forEach(a=>{
      a.parts.forEach(p=>{
        const wh = state.warehouses.find(w=>w.id===p.warehouseId);
        if(!wh) return;
        const idx = state.warehouses.findIndex(w=>w.id===wh.id);
        const color = colorFor(idx);
        if(p.routeCoords && p.routeCoords.length>1){
          L.polyline(p.routeCoords, {color, weight:3.5, opacity:0.7}).addTo(routesLayer);
        } else {
          L.polyline([[wh.lat,wh.lng],[a.demand.lat,a.demand.lng]], {color, weight:2, opacity:0.5, dashArray:'6 6'}).addTo(routesLayer);
        }
      });
    });
  }

  function renderLegend(){
    const legend = $('#legend');
    legend.innerHTML = '';
    state.warehouses.forEach((wh, idx)=>{
      const span = document.createElement('span');
      span.innerHTML = `<span class="lg-swatch" style="background:${wh.active?colorFor(idx):'#3a4a60'}"></span>${escapeHtml(wh.name)}${wh.active?'':' (inactivo)'}`;
      legend.appendChild(span);
    });
    if(state.lastResult){
      let s;
      s = document.createElement('span'); s.innerHTML = `<span class="lg-swatch" style="background:#0d1520"></span>Sin asignar`; legend.appendChild(s);
      s = document.createElement('span'); s.innerHTML = `<span class="lg-swatch" style="background:#dbe4f0"></span>Dividida entre almacenes`; legend.appendChild(s);
      s = document.createElement('span'); s.innerHTML = `<span class="lg-line" style="background:var(--text-dim);"></span>Ruta real por calle`; legend.appendChild(s);
      s = document.createElement('span'); s.innerHTML = `<span class="lg-line" style="background:var(--text-dim); background-image:repeating-linear-gradient(90deg,var(--text-dim) 0 4px, transparent 4px 8px); background-color:transparent;"></span>Ruta aproximada (sin datos de calle)`; legend.appendChild(s);
    }
  }

  /* ============== INIT ============== */
  renderWarehouses();
  renderDemands();
  redrawMarkers();
  resetKpis();
  setTimeout(()=> map.invalidateSize(), 200);

})();
