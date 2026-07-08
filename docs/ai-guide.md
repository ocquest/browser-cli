# Guía para Agentes de IA — Uso de `br` (Browser CLI)

Esta guía está pensada para **agentes de inteligencia artificial** (LLMs) que utilizan la herramienta `br` para interactuar con navegadores web. El objetivo es que actúes con **método, paciencia y precisión**, evitando errores comunes.

---

## Principio fundamental: Lee antes de actuar

Nunca te apresures a hacer clics o rellenar formularios sin antes entender la página. La web es impredecible: puede tener popups, cambios de layout, elementos que se cargan tarde, etc.

**Siempre sigue este orden:**

1. **Navega** a la URL
2. **Espera** a que cargue (2-3 segundos)
3. **Examina** la página con `view-tree` o `view-html`
4. **Planifica** qué elementos necesitas y dónde están
5. **Actúa** con el método correcto (ydotool primero)
6. **Verifica** que la acción funcionó

---

## Flujo de trabajo recomendado

### 1. Navegar

```bash
br goto <url>
```

Siempre verifica el título después de navegar para confirmar que cargó bien:

```bash
br eval "document.title"
```

### 2. Entender la página (NO TE SALTES ESTO)

Usa `view-tree` para obtener una visión estructurada de la página:

```bash
br view-tree [--role button,link,input --only-matches]
```

El `view-tree` te da IDs numéricos para cada elemento. Úsalos para interactuar de forma precisa.

Si necesitas ver el HTML completo:

```bash
br view-html [--page N]
```

Si necesitas ver cómo se ve visualmente:

```bash
br screenshot
br screenshot --base64  # si necesitas ver la imagen como agente
```

### 3. Planificar antes de actuar

Antes de hacer clic, pregúntate:
- ¿Qué elementos necesito?
- ¿Tienen IDs en el `view-tree`?
- ¿Hay popups o banners que bloqueen?
- ¿El elemento está visible o necesita scroll?

### 4. Interactuar (ydotool primero)

Usa **ydotool** siempre que sea posible (es indetectable):

```bash
br yclick <nodeId>
br ydrag <fromId> <toId>
```

Si ydotool falla (elemento no visible, etc.), usa Playwright como fallback:

```bash
br click <selector>      # solo si yclick falla
br fill <selector> texto  # rellenar formularios
br type <selector> texto  # escribir caracter por caracter
br press Enter            # presionar teclas
```

### 5. Verificar cada paso

Después de cada acción, confirma que funcionó:

```bash
# ¿Navegó a la página correcta?
br eval "document.title"

# ¿El texto se rellenó correctamente?
br eval "document.querySelector('input').value"

# ¿Apareció un resultado?
br view-tree --match "resultado" --only-matches
```

---

## Reglas de oro

### No te apresures

- **NO** hagas múltiples acciones sin verificar entre cada una
- **NO** asumas que una página tiene cierta estructura
- **NO** uses `click` (Playwright) si `yclick` puede funcionar
- **NO** navegues a URLs diferentes sin verificar la página actual
- **NO** hagas scroll y clic en el mismo paso

### Usa los IDs de view-tree

El `view-tree` asigna IDs numéricos a cada elemento. Son mucho más fiables que los selectores CSS porque:
- No dependen de clases que cambian
- Son únicos
- El daemon los resuelve a XPath automáticamente

### Capturas de pantalla para contexto visual

Cuando necesites entender la disposición visual de la página:

```bash
br screenshot --base64
```

Para un elemento concreto:

```bash
br screenshot-element <selector> --margin 10 --base64
```

### Manejo de errores

Si algo falla:
1. Lee el mensaje de error
2. Vuelve a examinar la página (`view-tree`)
3. Prueba con un selector diferente
4. Si ydotool falla, prueba con Playwright (`click`)
5. Si Playwright también falla, haz una captura para ver el estado visual

---

## Resumen rápido

| Situación | Comando |
|-----------|---------|
| Navegar a URL | `br goto <url>` |
| Ver estructura | `br view-tree` |
| Ver HTML | `br view-html` |
| Ver captura | `br screenshot --base64` |
| Clic (principal) | `br yclick <id>` |
| Clic (fallback) | `br click <selector>` |
| Rellenar campo | `br fill <selector> <texto>` |
| Escribir texto | `br type <selector> <texto>` |
| Presionar tecla | `br press <key>` |
| Capturar elemento | `br screenshot-element <id> --base64` |
| Arrastrar | `br ydrag <fromId> <toId>` |
| JavaScript | `br eval <código>` |
| Historial | `br history` |
| Esperar | `sleep <segundos>` |

Recuerda: **leen con calma, planifican y luego actúan**. Cada paso debe ser deliberado.
