# 🚚 Asignador Heurístico de Redes Logísticas

> Sistema interactivo de asignación óptima **almacén ↔ zona de demanda** usando **distancias reales por calle (OSRM)** y solvers **VAM + MODI** / **Branch & Bound**.

[![HTML5](https://img.shields.io/badge/HTML5-E34F26?style=for-the-badge&logo=html5&logoColor=white)](https://developer.mozilla.org/es/docs/Web/HTML)
[![CSS3](https://img.shields.io/badge/CSS3-1572B6?style=for-the-badge&logo=css3&logoColor=white)](https://developer.mozilla.org/es/docs/Web/CSS)
[![JavaScript](https://img.shields.io/badge/JavaScript-F7DF1E?style=for-the-badge&logo=javascript&logoColor=black)](https://developer.mozilla.org/es/docs/Web/JavaScript)
[![Leaflet](https://img.shields.io/badge/Leaflet-199900?style=for-the-badge&logo=leaflet&logoColor=white)](https://leafletjs.com/)
[![License](https://img.shields.io/badge/License-MIT-blue?style=for-the-badge)](#-licencia)

---

## 📖 Descripción

El **Asignador Heurístico de Redes Logísticas** es una aplicación web autocontenida (un único archivo HTML) que permite:

- 📍 **Ubicar geográficamente** almacenes (oferta) y zonas de demanda (clientes) directamente sobre el mapa.
- 🛣️ **Calcular distancias reales por calle** mediante el motor de ruteo **OSRM**.
- ⚙️ **Resolver el problema de transporte** con dos regímenes de negocio: fraccionamiento permitido (VAM + MODI) o indivisible (Branch & Bound).
- 📊 **Visualizar KPIs, rutas y utilización** de capacidad en tiempo real.

Está diseñado como entregable académico para el curso de **Logística** de la *Universidad Nacional de Ucayali*, con una instancia de ejemplo anclada al casco urbano de **Pucallpa, Perú**.

---

## ✨ Características principales

| Módulo | Descripción |
|---|---|
| 🏭 **Almacenes** | CRUD completo con capacidad, estado activo/inactivo y georreferenciación por clic. |
| 📦 **Zonas de demanda** | CRUD con demanda solicitada y semaforización post-optimización. |
| 🗺️ **Mapa Leaflet** | Vista 2D (OSM) y vista satelital (Esri World Imagery) conmutables. |
| 🔎 **Geocodificación** | Búsqueda de direcciones vía **Nominatim** (OSM). |
| 🚗 **Ruteo real** | API pública de **OSRM** (perfil `driving`) con caché por par de coordenadas. |
| 🧮 **Solver continuo** | **VAM + MODI** con balanceo por nodo ficticio (modo *dividir*). |
| 🌳 **Solver exacto** | **Branch & Bound** con semilla voraz, cota dual y poda por capacidad (modo *no dividir*). |
| 📉 **KPIs** | Costo total, distancia ponderada (km·unidad), % de satisfacción y almacenes saturados. |
| 📤 **Persistencia** | Exportación / importación JSON con validación estructural estricta. |
| 🎨 **Tema claro/oscuro** | Preferencia persistida en `localStorage`. |

---

## 🧠 Modelado matemático

### Función de costo

$$
A_{ij} = d_{ij} \cdot \tau \cdot r
$$

$$
C_{ij} = A_{ij} \cdot (1 + 0{,}01 \cdot D_j)
$$

donde:

- $d_{ij}$ = distancia real (OSRM) o estimada (Haversine × $r$) entre almacén $i$ y zona $j$.
- $\tau$ = tarifa ($/unidad·km).
- $r$ = factor de seguridad (circuidad).
- $D_j$ = demanda de la zona $j$.

### Modo *dividir* → VAM + MODI

Problema clásico de transporte con oferta $S_i$ y demanda $D_j$:

$$
\min \sum_i \sum_j C_{ij} \, x_{ij} \quad \text{s.a.} \quad \sum_j x_{ij} \le S_i,\; \sum_i x_{ij} \le D_j,\; x_{ij} \ge 0
$$

### Modo *no dividir* → Branch & Bound

Problema de Asignación Generalizada (GAP) binario:

$$
x_{ij} \in \{0,1\}, \quad \sum_i x_{ij} \le 1, \quad \sum_j D_j x_{ij} \le S_i
$$

Si ningún almacén tiene capacidad residual para $D_j$, la zona queda **explícitamente sin servir** (0 unidades, 0 costo).

---

## 🛠️ Stack tecnológico

| Capa | Tecnología | Función |
|---|---|---|
| Presentación | HTML5 + CSS3 (custom properties) | SPA, layout de dos columnas, temas claro/oscuro |
| Lógica | JavaScript Vanilla (IIFE, `strict`) | Estado, CRUD, validación, orquestación |
| Cartografía | Leaflet 1.9.4 + OSM / Esri | Mapa 2D, vista satelital, marcadores y rutas |
| Geocodificación | Nominatim (OSM) | Búsqueda de direcciones |
| Ruteo | OSRM (`driving`) | Distancia y polilínea por calle |
| Optimización | VAM + MODI / B&B | Asignación con/sin fraccionamiento |
| Persistencia | JSON (`Blob` / `FileReader`) | Exportar / importar la red |

> ⚡ **Sin build step, sin frameworks, sin bundlers.** Todo vive en un único archivo HTML auditable línea por línea.

---

## 🚀 Instalación y uso

### Requisitos

- Navegador moderno (Chrome, Firefox, Edge o Safari).
- Conexión a Internet para teselas del mapa, Nominatim y OSRM.
- No requiere servidor propio ni base de datos.

### Pasos

1. **Clona o descarga** el repositorio:
   ```bash
   git clone https://github.com/<usuario>/<repo>.git
