#!/usr/bin/env python3
"""Generic XSD tree expansion tool.

Features:
- Parses an XSD file (and its <xs:include> direct includes) and builds a tree
  of selected root element(s) with recursive complexType expansion.
- Outputs plain text and interactive HTML with collapsible sections.
- Caches type expansions to avoid repeated work.
- Provides --expand-all / --collapse-all controls via HTML buttons + JS.
- Generic: choose XSD path, root element(s), output directory and file prefix.

Usage examples:
  python xsd_tree.py                            # defaults
  python xsd_tree.py --xsd path/to/schema.xsd   # generic schema
  python xsd_tree.py --root Order --root Invoice # only specific global elements
  python xsd_tree.py --out-dir ./out --prefix my-schema

"""
import argparse
import xml.etree.ElementTree as ET
from pathlib import Path
from typing import Dict, Set, List, Optional

XS = "{http://www.w3.org/2001/XMLSchema}"
BUILTIN_PREFIX = "xs:"

# -------------------- Helpers --------------------

def attr(el: ET.Element, name: str, default: Optional[str] = None) -> Optional[str]:
    return el.attrib.get(name, default)

# -------------------- Model Loading --------------------

class SchemaModel:
    def __init__(self, main_xsd: Path, max_depth: int = 50):
        self.main_xsd = main_xsd
        self.schema_dir = main_xsd.parent
        self.types: Dict[str, ET.Element] = {}
        self.attr_groups: Dict[str, ET.Element] = {}
        self.max_depth = max_depth
        self._load()

    def _parse(self, path: Path) -> ET.Element:
        return ET.parse(path).getroot()

    def _harvest(self, root: ET.Element):
        for ct in root.findall(f"{XS}complexType"):
            name = attr(ct, "name")
            if name:
                self.types[name] = ct
        for ag in root.findall(f"{XS}attributeGroup"):
            name = attr(ag, "name")
            if name:
                self.attr_groups[name] = ag

    def _load(self):
        def dfs(path: Path, depth: int, visited: Set[Path]):
            if depth > self.max_depth:
                print(f"[WARN] Max recursion depth reached ({self.max_depth}) at {path}; skipping deeper traversal")
                return None
            if path in visited:
                print(f"[DEBUG] Skipping already visited: {path}")
                return None
            if not path.exists():
                print(f"[WARN] XSD not found: {path}")
                return None
            visited.add(path)
            indent = '  ' * depth
            try:
                print(f"{indent}[INFO] Parsing: {path}")
                root = self._parse(path)
            except ET.ParseError as e:
                print(f"{indent}[WARN] Parse error in {path}: {e}")
                return None
            self._harvest(root)
            # process includes/imports depth-first
            for tag in (f"{XS}include", f"{XS}import"):
                for node in root.findall(tag):
                    loc = attr(node, "schemaLocation")
                    if not loc:
                        # import without schemaLocation often uses namespace only
                        ns = attr(node, 'namespace')
                        if tag.endswith('import'):
                            print(f"{indent}[DEBUG] import without schemaLocation (namespace={ns}) in {path} - skipped")
                        continue
                    # Resolve relative to current file's directory
                    next_path = path.parent / loc
                    if not next_path.exists():
                        print(f"{indent}[WARN] {tag.split('}')[-1]} not found: {next_path}")
                        continue
                    print(f"{indent}[INFO] {tag.split('}')[-1].capitalize()} -> {next_path}")
                    dfs(next_path, depth + 1, visited)
            return root

        print(f"[INFO] Loading main XSD: {self.main_xsd}")
        visited: Set[Path] = set()
        root_main = dfs(self.main_xsd, 0, visited)
        if root_main is None:
            raise SystemExit(f"Failed to load main XSD: {self.main_xsd}")
        self.root_main = root_main
        print(f"[INFO] Total XSD files loaded: {len(visited)}")
        print(f"[INFO] Complex types harvested: {len(self.types)}; Attribute groups: {len(self.attr_groups)}")

    def get_complex_type(self, name: str) -> Optional[ET.Element]:
        el = self.types.get(name)
        if el is not None and el.tag.endswith('complexType'):
            return el
        return None

    def get_attribute_group(self, name: str) -> Optional[ET.Element]:
        el = self.attr_groups.get(name)
        if el is not None and el.tag.endswith('attributeGroup'):
            return el
        return None

    def list_global_elements(self) -> List[ET.Element]:
        return list(self.root_main.findall(f"{XS}element"))

# -------------------- Expansion with caching --------------------

type_struct_cache: Dict[str, Dict] = {}

def expand_type_structure(model: SchemaModel, type_name: str, stack: Set[str]) -> Dict:
    if not type_name or type_name.startswith(BUILTIN_PREFIX):
        return {"name": type_name, "builtin": True}
    if type_name in stack:
        return {"name": type_name, "cycle": True}
    if type_name in type_struct_cache:
        return type_struct_cache[type_name]
    ct = model.get_complex_type(type_name)
    if ct is None:
        return {"name": type_name, "missing": True}
    stack.add(type_name)
    info: Dict = {"name": type_name, "elements": [], "attributes": [], "attrGroups": []}
    ext = ct.find(f"{XS}complexContent/{XS}extension")
    if ext is not None:
        base = attr(ext, "base")
        if base:
            info["base"] = expand_type_structure(model, base, stack)
        particle = ext.find(f"{XS}sequence") or ext.find(f"{XS}choice") or ext.find(f"{XS}all")
        if particle is not None:
            info["elements"].extend(list(particle))
        info["attributes"].extend(ext.findall(f"{XS}attribute"))
        info["attrGroups"].extend([attr(ag, "ref") for ag in ext.findall(f"{XS}attributeGroup")])
    else:
        particle = ct.find(f"{XS}sequence") or ct.find(f"{XS}choice") or ct.find(f"{XS}all")
        if particle is not None:
            info["elements"].extend(list(particle))
        info["attributes"].extend(ct.findall(f"{XS}attribute"))
        info["attrGroups"].extend([attr(ag, "ref") for ag in ct.findall(f"{XS}attributeGroup")])
    stack.remove(type_name)
    type_struct_cache[type_name] = info
    return info

# -------------------- Summary helpers --------------------

def element_summary(el: ET.Element) -> str:
    name = attr(el, "name")
    typ = attr(el, "type")
    mino = attr(el, "minOccurs", "1")
    maxo = attr(el, "maxOccurs", "1")
    occ = f" [{mino}..{maxo}]" if (mino != "1" or maxo != "1") else ""
    return f"{name}: {typ}{occ}" if typ else f"{name}{occ}"

def attribute_summary(a: ET.Element) -> str:
    name = attr(a, "name")
    typ = attr(a, "type")
    use = attr(a, "use")
    default = attr(a, "default")
    meta = []
    if typ: meta.append(typ)
    if use: meta.append(f"use={use}")
    if default is not None: meta.append(f"default={default}")
    return f"@{name}" + (" (" + ", ".join(meta) + ")" if meta else "")

def esc(text: str) -> str:
    return (text or "").replace('&','&amp;').replace('<','&lt;').replace('>','&gt;')

def element_summary_html(el: ET.Element) -> str:
    name = attr(el, "name") or "(unnamed)"
    typ = attr(el, "type")
    mino = attr(el, "minOccurs", "1")
    maxo = attr(el, "maxOccurs", "1")
    occ = f" [{mino}..{maxo}]" if (mino != "1" or maxo != "1") else ""
    name_html = f"<span class='code'>{esc(name)}</span>"
    if typ:
        return f"{name_html}: {esc(typ)}{esc(occ)}"
    return f"{name_html}{esc(occ)}"

def attribute_summary_html(a: ET.Element) -> str:
    name = attr(a, "name") or "(unnamed)"
    typ = attr(a, "type")
    use = attr(a, "use")
    default = attr(a, "default")
    meta = []
    if typ: meta.append(esc(typ))
    if use: meta.append(f"use={esc(use)}")
    if default is not None: meta.append(f"default={esc(default)}")
    name_html = f"<span class='code'>@{esc(name)}</span>"
    return name_html + (" (" + ", ".join(meta) + ")" if meta else "")

# -------------------- Rendering (HTML) --------------------

def render_type_html(model: SchemaModel, struct: Dict, stack: Set[str]) -> str:
    parts: List[str] = []
    parts.append("<div class='type'>")
    flags = []
    if struct.get("builtin"): flags.append("builtin")
    if struct.get("missing"): flags.append("missing")
    if struct.get("cycle"): flags.append("cycle")
    if flags:
        parts.append(f"<p class='mono'>({', '.join(flags)})</p>")
    if struct.get("base"):
        parts.append("<details><summary>base</summary>")
        parts.append(render_type_html(model, struct["base"], stack))
        parts.append("</details>")
    els = struct.get("elements", [])
    if els:
        parts.append("<details open><summary>elements</summary><ul>")
        for child in els:
            if child.tag == f"{XS}element":
                parts.append(render_element_html(model, child, stack))
            elif child.tag in (f"{XS}sequence", f"{XS}choice", f"{XS}all"):
                label = child.tag.split('}')[-1]
                parts.append(f"<li class='exp'><details><summary>{esc(label)}</summary><ul>")
                for grand in list(child):
                    if grand.tag == f"{XS}element":
                        parts.append(render_element_html(model, grand, stack))
                parts.append("</ul></details></li>")
        parts.append("</ul></details>")
    attrs = struct.get("attributes", [])
    if attrs:
        parts.append("<details><summary>attributes</summary><ul>")
        for a in attrs:
            parts.append(f"<li>{attribute_summary_html(a)}</li>")
        parts.append("</ul></details>")
    for agr in struct.get("attrGroups", []):
        grp = model.get_attribute_group(agr or "")
        if grp is not None:
            group_attrs = grp.findall(f"{XS}attribute")
            parts.append(f"<details><summary>attributeGroup <span class='code'>{esc(agr)}</span></summary><ul>")
            for ga in group_attrs:
                parts.append(f"<li>{attribute_summary_html(ga)}</li>")
            parts.append("</ul></details>")
    parts.append("</div>")
    return "".join(parts)

def render_element_html(model: SchemaModel, el: ET.Element, stack: Set[str]) -> str:
    typ = attr(el, "type")
    ct = model.get_complex_type(typ) if typ else None
    summary_html = element_summary_html(el)
    if ct is None or (typ and typ.startswith(BUILTIN_PREFIX)):
        return f"<li>{summary_html}</li>"
    struct = expand_type_structure(model, typ, stack)
    return f"<li class='exp'><details><summary>{summary_html}</summary>{render_type_html(model, struct, stack)}</details></li>"

# -------------------- Rendering (Text) --------------------

def render_type_txt(model: SchemaModel, struct: Dict, buf: List[str], depth: int, stack: Set[str]):
    flags = []
    if struct.get("builtin"): flags.append("builtin")
    if struct.get("missing"): flags.append("missing")
    if struct.get("cycle"): flags.append("cycle")
    if flags:
        buf.append("  " * depth + f"(" + ", ".join(flags) + ")")
    if struct.get("base"):
        buf.append("  " * depth + "base:")
        render_type_txt(model, struct["base"], buf, depth + 1, stack)
    els = struct.get("elements", [])
    if els:
        buf.append("  " * depth + "elements:")
        for child in els:
            if child.tag == f"{XS}element":
                render_element_txt(model, child, buf, depth + 1, stack)
            elif child.tag in (f"{XS}sequence", f"{XS}choice", f"{XS}all"):
                label = child.tag.split('}')[-1]
                buf.append("  " * (depth + 1) + f"{label}:")
                for grand in list(child):
                    if grand.tag == f"{XS}element":
                        render_element_txt(model, grand, buf, depth + 2, stack)
    attrs = struct.get("attributes", [])
    if attrs:
        buf.append("  " * depth + "attributes:")
        for a in attrs:
            buf.append("  " * (depth + 1) + "- " + attribute_summary(a))
    for agr in struct.get("attrGroups", []):
        grp = model.get_attribute_group(agr or "")
        if grp is not None:
            buf.append("  " * depth + f"attributeGroup {agr}:")
            for ga in grp.findall(f"{XS}attribute"):
                buf.append("  " * (depth + 1) + "- " + attribute_summary(ga))

def render_element_txt(model: SchemaModel, el: ET.Element, buf: List[str], depth: int, stack: Set[str]):
    summ = element_summary(el)
    typ = attr(el, "type")
    buf.append("  " * depth + f"- {summ}")
    if not typ or typ.startswith(BUILTIN_PREFIX):
        return
    ct = model.get_complex_type(typ)
    if ct is None:
        return
    struct = expand_type_structure(model, typ, stack)
    render_type_txt(model, struct, buf, depth + 1, stack)

# -------------------- Build Outputs --------------------

def build_html(model: SchemaModel, root_names: List[str], title_prefix: str) -> str:
    import datetime
    # Determine roots
    globals_all = model.list_global_elements()
    roots = [el for el in globals_all if (not root_names or attr(el, 'name') in root_names)]
    timestamp = datetime.datetime.now().strftime('%Y-%m-%d %H:%M:%S')
    parts = [
        "<!DOCTYPE html>",
        "<html lang='en'><head><meta charset='utf-8'>",
        f"<title>{esc(title_prefix)} - Expanded XSD Tree</title>",
        "<style>",
        # Dark theme via CSS variables and prefers-color-scheme
        "  :root{--bg:#ffffff;--fg:#111111;--muted:#666666;--border:#d5d5d5;--link:#0a66c2;}",
        "  @media (prefers-color-scheme: dark){",
        "    :root{--bg:#1e2228;--fg:#c9d1d9;--muted:#9aa3ab;--border:#2a2f37;--link:#58a6ff;}",
        "  }",
        "  html,body{background:var(--bg);color:var(--fg)}",
        "  body{font-family:Segoe UI,Arial,sans-serif;font-size:14px;line-height:1.45;margin:14px}",
        "  a{color:var(--link)}",
        "  ul{list-style:none;margin:0;padding-left:0.6em}",
        "  details{margin:1px 0;padding:0}",
        "  summary{cursor:pointer;font-weight:500;padding:1px 0}",
        "  .mono{font-family:Consolas,monospace;color:var(--muted);font-size:12px}",
        "  .code{font-family:Consolas,monospace;letter-spacing:0.5px}",
        "  li{margin:0;padding:0}",
        "  .type{margin-left:0.4em;border-left:2px solid var(--border);padding-left:4px}",
        "  .type .type{margin-left:0.4em}",
        "  h1,h2{margin:4px 0 6px;font-weight:600}",
        "  h2{font-size:15px}",
        "  .controls{margin:6px 0;display:flex;align-items:center;gap:10px}",
        "  .timestamp{font-family:Consolas,monospace;color:var(--muted);font-size:12px;margin-left:8px}",
        "  button{margin-right:6px;padding:4px 10px;background:transparent;color:var(--fg);border:1px solid var(--border);border-radius:6px;font-size:12px}",
        "  button:hover{border-color:var(--muted)}",
        "</style>",
        "</head><body>"
    ]
    parts.append(f"<div class='controls'><button id='expandAll'>Expand All</button><button id='collapseAll'>Collapse All</button><span class='timestamp'>Generated: {timestamp}</span></div>")
    stack: Set[str] = set()
    for root_el in roots:
        rname = attr(root_el, 'name') or '(unnamed)'
        parts.append(f"<h2>Root element: <span class='code'>{esc(rname)}</span></h2>")
        ext = root_el.find(f"{XS}complexType/{XS}complexContent/{XS}extension")
        base_type = attr(ext, 'base') if ext is not None else None
        if base_type:
            parts.append(f"<p class='mono'>Base type: {esc(base_type)}</p>")
            struct = expand_type_structure(model, base_type, stack)
            parts.append("<details open><summary>content</summary>")
            parts.append(render_type_html(model, struct, stack))
            parts.append("</details>")
        else:
            ctype = root_el.find(f"{XS}complexType")
            if ctype is not None:
                temp_name = attr(ctype, 'name') or f"__anon_{rname}"
                model.types[temp_name] = ctype
                struct = expand_type_structure(model, temp_name, stack)
                parts.append("<details open><summary>content</summary>")
                parts.append(render_type_html(model, struct, stack))
                parts.append("</details>")
            else:
                # Handle the common case: root element references an existing global complexType via type="..."
                ref_type = attr(root_el, 'type')
                if ref_type and not ref_type.startswith(BUILTIN_PREFIX):
                    parts.append(f"<p class='mono'>Referenced type: {esc(ref_type)}</p>")
                    struct = expand_type_structure(model, ref_type, stack)
                    parts.append("<details open><summary>content</summary>")
                    parts.append(render_type_html(model, struct, stack))
                    parts.append("</details>")
    parts.append("<script>function toggleAll(open){document.querySelectorAll('details').forEach(d=>d.open=open);}document.getElementById('expandAll').addEventListener('click',()=>toggleAll(true));document.getElementById('collapseAll').addEventListener('click',()=>toggleAll(false));</script>")
    parts.append("</body></html>")
    return "\n".join(parts)

def build_txt(model: SchemaModel, root_names: List[str]) -> str:
    globals_all = model.list_global_elements()
    roots = [el for el in globals_all if (not root_names or attr(el, 'name') in root_names)]
    buf: List[str] = []
    stack: Set[str] = set()
    for root_el in roots:
        rname = attr(root_el, 'name') or '(unnamed)'
        buf.append(f"Root element: {rname}")
        ext = root_el.find(f"{XS}complexType/{XS}complexContent/{XS}extension")
        base_type = attr(ext, 'base') if ext is not None else None
        if base_type:
            buf.append(f"Base type: {base_type}")
            struct = expand_type_structure(model, base_type, stack)
            render_type_txt(model, struct, buf, 1, stack)
        else:
            ctype = root_el.find(f"{XS}complexType")
            if ctype is not None:
                temp_name = attr(ctype, 'name') or f"__anon_{rname}"
                model.types[temp_name] = ctype
                struct = expand_type_structure(model, temp_name, stack)
                render_type_txt(model, struct, buf, 1, stack)
            else:
                # Root element referencing a named complexType via type attribute
                ref_type = attr(root_el, 'type')
                if ref_type and not ref_type.startswith(BUILTIN_PREFIX):
                    buf.append(f"Referenced type: {ref_type}")
                    struct = expand_type_structure(model, ref_type, stack)
                    render_type_txt(model, struct, buf, 1, stack)
    return "\n".join(buf)

# -------------------- CLI --------------------

def parse_args():
    p = argparse.ArgumentParser(description="Generate expanded tree view of XSD schema.")
    p.add_argument('--xsd', default="C:/workspace/schema-proj/src/main/resources/schemas/my-schema.xsd", help='Path to main XSD file.')
    p.add_argument('--root', action='append', help='Root element name(s) to include. If omitted, all global xs:element are included.')
    p.add_argument('--out-dir', default=".", help='Output directory.')
    p.add_argument('--prefix', default=None, help='Output file prefix (defaults to stem of XSD file).')
    p.add_argument('--max-depth', type=int, default=50, help='Maximum recursion depth when traversing includes/imports.')
    return p.parse_args()

# -------------------- Main --------------------

def main():
    args = parse_args()
    xsd_path = Path(args.xsd)
    if not xsd_path.exists():
        raise SystemExit(f"XSD not found: {xsd_path}")
    prefix = args.prefix or xsd_path.stem
    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    print(f"[INFO] Output directory: {out_dir}")
    model = SchemaModel(xsd_path, max_depth=args.max_depth)
    global_elems = [attr(e,'name') for e in model.list_global_elements()]
    print(f"[INFO] Global elements found: {len(global_elems)} -> {global_elems[:10]}{'...' if len(global_elems)>10 else ''}")
    roots_requested = args.root or []
    if roots_requested:
        print(f"[INFO] Filtering roots to: {roots_requested}")
    html = build_html(model, roots_requested, prefix)
    txt = build_txt(model, roots_requested)
    html_path = out_dir / f"{prefix}-tree.html"
    txt_path = out_dir / f"{prefix}-tree.txt"
    html_path.write_text(html, encoding='utf-8')
    txt_path.write_text(txt, encoding='utf-8')
    print(f"[INFO] Wrote HTML: {html_path} (size={html_path.stat().st_size} bytes)")
    print(f"[INFO] Wrote TXT : {txt_path} (size={txt_path.stat().st_size} bytes)")

if __name__ == '__main__':
    main()
