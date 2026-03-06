#!/usr/bin/env bun

import { hostname, networkInterfaces } from "node:os";
import { extname, join, relative, resolve, sep } from "node:path";
import { mkdir, readdir, stat } from "node:fs/promises";

const DEFAULT_PATH = ".";

type SortBy = "name" | "size" | "date";
type SortOrder = "asc" | "desc";

const uploadRates = new Map<string, number[]>();

const faviconBase64 = "iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAC1UlEQVRYR+2XzWsTQRjGn9nZ3XSTdJM0YhK6KR5E9GDBQ0HRizQKInhR/BvUehA8WaxUi4IfFw96FPSkRxFEadCDePIiUr2oh1aTFDa06Vey3XysMyMtjcm61bRJD31hAyGTmd/7zPuxL8EopNTh1DCAC+xJsKcdlmOHPEy/T98iqfHUVfZlrB2nNjljhAyOD+YISLwTAA6caa6A04nDV87cBth6ChReF2BnbM+wCA4E4d/vX11Xzpex8G4B1jcLlUIFYJEl+SUoOxR07e5CYCAAOSQ37NugQO5+DqUvJU+AntM9CB8Pi3WLHxZhPjbhlN3jWdunIXGpscy4AtAQRSgVcgXR9mjw7fLBztnIjGXgVB1QnSJ8Iiw8JgpBtVCF9d0SgPoRHaFjjfu5AqiGCmPE8FQi/yyP+TfzTG/AuGZATaiN/2HCOBVHQP1pLQNk72VhfbWg9jJgBvCv1jrAXQbAAo/L33e7D0Rq9PJvUC0D5J+yK3jLroCZflRH9EwURF4/RMsAZbOMzM0MaqWagJAjMoIHgwgcCMDX5wM8WNzTkAWV5GMfTUzZqaB3uHf1l+UfyzAfmbCz9fVD7pHRfagb+qAOGqBN9/qvOqDEFCRvJOs2dGoOip+KIuVKEyXUrN+KcKPdFLFzMZGe684CJaEgfrF5lyaUCKndjBek4uci5tJzIkO4SQEJyetJAbPWWo4Br7SbeT6DwsuCWBY5FUHkZKS9APxqJi9Polaswd/vR3yoXtVNV4C7O3VlCpWZyuYArDSgZmWWH857QfZOdvOuYOnjEswnJnh71vZqUOIKpC4J1cUqihMsEF/NiYygQQpj1Nj4IFxbCd0CkoYp4ufjont6puHsi1nwwsJfJKJno15BLroc95Snnf3TFi2Ye0xUAjWmQuvXRCvmqjSzrfdK5unyBi/YVqCjoxm7TTGadXY4XRnP2aA41MYhdZp5/4CP578A2bR8uBXi+eIAAAAASUVORK5CYII=";

function formatSize(size: number): string {
  let value = size;
  for (const unit of ["B", "KB", "MB", "GB"]) {
    if (value < 1024) return `${value.toFixed(1)} ${unit}`;
    value /= 1024;
  }
  return `${value.toFixed(1)} TB`;
}

function getFileIcon(filename: string, isDir: boolean): string {
  if (isDir) return "📁";
  const nameLower = filename.toLowerCase();
  if (nameLower.endsWith(".tar.gz")) return "📦";
  const ext = extname(filename).toLowerCase();
  const icons: Record<string, string> = {
    ".txt": "📄",
    ".pdf": "📕",
    ".jpg": "🖼️",
    ".jpeg": "🖼️",
    ".png": "🖼️",
    ".gif": "🖼️",
    ".bmp": "🖼️",
    ".mp3": "🎵",
    ".wav": "🎵",
    ".flac": "🎵",
    ".mp4": "🎥",
    ".avi": "🎥",
    ".mkv": "🎥",
    ".zip": "📦",
    ".rar": "📦",
    ".7z": "📦",
    ".py": "🐍",
    ".js": "📜",
    ".html": "🌐",
    ".css": "🎨",
    ".sh": "⚙️",
    ".gz": "📦",
    ".log": "📝",
    ".xml": "🏷️",
  };
  return icons[ext] ?? "📄";
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function safeJoin(base: string, ...paths: string[]): string {
  const basePath = resolve(base);
  const fullPath = resolve(base, ...paths);
  const rel = relative(basePath, fullPath);
  if (rel.startsWith("..") || rel.includes(`..${sep}`)) {
    throw new Error("Path traversal detected");
  }
  return fullPath;
}

function parseArgs() {
  let servePath = DEFAULT_PATH;
  let port = 8088;
  let host = "0.0.0.0";
  const args = Bun.argv.slice(2);

  for (let i = 0; i < args.length; i++) {
    const key = args[i];
    const value = args[i + 1];
    if (key === "--path" && value) {
      servePath = value;
      i++;
    } else if (key === "--port" && value) {
      port = Number.parseInt(value, 10) || port;
      i++;
    } else if (key === "--host" && value) {
      host = value;
      i++;
    }
  }

  return { servePath, port, host };
}

function getLocalIPv4Address() {
  const interfaces = networkInterfaces();
  for (const group of Object.values(interfaces)) {
    if (!Array.isArray(group)) continue;
    for (const iface of group) {
      if (iface.family === "IPv4" && !iface.internal) return iface.address;
    }
  }
  return "127.0.0.1";
}

function errorPage(title: string, message: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <title>${escapeHtml(title)}</title>
    <style>
        :root { --bg-color: white; --text-color: #808080; --hover-color: #ff7d12; }
        :root[data-theme="dark"] { --bg-color: #121212; --text-color: #cccccc; }
        body { background-color: var(--bg-color); color: var(--text-color); font-family: Arial, sans-serif; text-align: center; padding: 50px; }
        h1 { color: var(--hover-color); }
        a { color: var(--text-color); }
    </style>
    <script>
        const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
        const savedTheme = localStorage.getItem('theme');
        const theme = savedTheme || (prefersDark ? 'dark' : 'light');
        document.documentElement.setAttribute('data-theme', theme);
    </script>
</head>
<body>
    <h1>${escapeHtml(title)}</h1>
    <p>${escapeHtml(message)}</p>
    <a href="/">Go Home</a>
</body>
</html>`;
}

function directoryPage(params: {
  title: string;
  items: Array<{ cssClass: string; icon: string; name: string; href: string; size: string; mtime: string }>;
  pagination: boolean;
  page: number;
  totalPages: number;
  hostName: string;
  env: string;
  breadcrumbs: Array<{ name: string; href: string }>;
  sortBy: SortBy;
  order: SortOrder;
  currentPath: string;
}): string {
  const breadcrumbHtml = params.breadcrumbs.length
    ? `<nav><a href="/">Home</a>${params.breadcrumbs
        .map((crumb) => ` / <a href="/${crumb.href}">${escapeHtml(crumb.name)}</a>`)
        .join("")}</nav>`
    : "";

  const paginationHtml = params.pagination
    ? `<div class="pagination">Page ${params.page} of ${params.totalPages}
      ${
        params.page > 1
          ? `<a href="?page=${params.page - 1}&sort=${params.sortBy}&order=${params.order}">Previous</a>`
          : ""
      }
      ${
        params.page < params.totalPages
          ? `<a href="?page=${params.page + 1}&sort=${params.sortBy}&order=${params.order}">Next</a>`
          : ""
      }
    </div>`
    : "";

  const rows = params.items
    .map(
      (item) => `<tr class="${item.cssClass}">
      <td>${item.icon}</td>
      <td><a href="${item.href}">${escapeHtml(item.name)}</a></td>
      <td>${escapeHtml(item.size)}</td>
      <td>${escapeHtml(item.mtime)}</td>
    </tr>`,
    )
    .join("\n");

  const nextOrder = (field: SortBy) =>
    params.sortBy === field && params.order === "asc" ? "desc" : "asc";

  return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <title>File Server - ${escapeHtml(params.title)}</title>
    <link href="data:image/png;base64,${faviconBase64}" rel="icon" type="image/x-icon" />
    <script>
        const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
        const savedTheme = localStorage.getItem('theme');
        const theme = savedTheme || (prefersDark ? 'dark' : 'light');
        document.documentElement.setAttribute('data-theme', theme);
    </script>
    <style>
        :root { --bg-color: white; --text-color: #808080; --hover-color: #ff7d12; --odd-bg: white; --even-bg: #f8f8f8; }
        :root[data-theme="dark"] { --bg-color: #121212; --text-color: #cccccc; --hover-color: #ff7d12; --odd-bg: #1e1e1e; --even-bg: #2a2a2a; }
        body { background-color: var(--bg-color); color: var(--text-color); font-family: Arial, sans-serif; font-size: 14px; margin: 0; padding: 0; }
        header { background-color: var(--odd-bg); padding: 10px; display: flex; justify-content: space-between; align-items: center; }
        header a { margin-right: 10px; }
        main { padding: 20px; }
        section { margin-bottom: 20px; }
        footer { background-color: var(--odd-bg); text-align: center; padding: 10px; position: fixed; bottom: 0; width: 100%; }
        ul { padding: 0; list-style: none; }
        li { list-style: none; padding: 0 .1em .1em .7em; margin: 0; }
        table { border-collapse: collapse; width: auto; margin: 0 auto; }
        th, td { padding: 8px 12px; text-align: left; border-bottom: 1px solid var(--text-color); }
        th { background-color: var(--odd-bg); font-weight: bold; }
        a:link, a:visited { color: var(--text-color); text-decoration: none; }
        a:hover, a:active { color: var(--hover-color); }
        .odd { background-color: var(--odd-bg); }
        .even { background-color: var(--even-bg); }
        .theme-toggle { background: var(--hover-color); color: white; border: none; padding: 5px 10px; cursor: pointer; border-radius: 5px; }
        .pagination { margin-top: 20px; text-align: center; }
        #search { padding: 5px; width: 200px; }
        @media (max-width: 768px) {
            body { font-size: 12px; }
            .table-container { overflow-x: auto; -webkit-overflow-scrolling: touch; }
            table { font-size: 12px; min-width: 600px; }
            th, td { padding: 4px 6px; white-space: nowrap; }
            .pagination { font-size: 12px; }
            #search { width: 120px; }
            header { flex-direction: column; align-items: flex-start; }
            header div { margin-bottom: 10px; width: 100%; display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; }
            .theme-toggle { margin: 0 5px; }
            form { margin: 0; }
        }
    </style>
</head>
<body>
    <header>
        <div>
            <a href="..">🏠 Home</a>
        </div>
        <div>
            <input type="text" id="search" placeholder="Search exact file name..." onkeyup="filterTable()">
            <button class="theme-toggle" onclick="toggleTheme()">Toggle Theme</button>
            <form action="/upload" method="post" enctype="multipart/form-data" style="display: inline;">
                <input type="hidden" name="path" value="${escapeHtml(params.currentPath)}">
                <input type="file" name="file" multiple>
                <input type="submit" value="Upload" class="theme-toggle">
            </form>
        </div>
    </header>
    ${breadcrumbHtml}
    <main>
        <section>
            ${paginationHtml}
            <div class="table-container">
            <table id="fileTable">
                <thead>
                    <tr>
                        <th>Type</th>
                        <th><a href="?sort=name&order=${nextOrder("name")}&page=1">Name</a></th>
                        <th><a href="?sort=size&order=${nextOrder("size")}&page=1">Size</a></th>
                        <th><a href="?sort=date&order=${nextOrder("date")}&page=1">Last Modified</a></th>
                    </tr>
                </thead>
                <tbody>
                ${rows}
                </tbody>
            </table>
            </div>
        </section>
    </main>
    <footer>
        File Server on ${escapeHtml(params.hostName)} - (${escapeHtml(params.env)})
    </footer>
    <script>
        function toggleTheme() {
            const root = document.documentElement;
            const currentTheme = root.getAttribute('data-theme');
            const newTheme = currentTheme === 'light' ? 'dark' : 'light';
            root.setAttribute('data-theme', newTheme);
            localStorage.setItem('theme', newTheme);
        }

        function filterTable() {
            const input = document.getElementById('search');
            const filter = input.value.toLowerCase();
            const table = document.getElementById('fileTable');
            const rows = table.getElementsByTagName('tr');

            for (let i = 1; i < rows.length; i++) {
                const cells = rows[i].getElementsByTagName('td');
                const nameCell = cells[1];
                const match = nameCell.textContent.toLowerCase().includes(filter);
                rows[i].style.display = match ? '' : 'none';
            }
        }
    </script>
</body></html>`;
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

function buildResponse(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

function clientIp(req: Request, server: Bun.Server): string {
  const forwarded = req.headers.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0].trim();
  return server.requestIP(req)?.address ?? "unknown";
}

const { servePath, port, host } = parseArgs();

const server = Bun.serve({
  hostname: host,
  port,
  async fetch(req: Request) {
    const started = Date.now();
    const url = new URL(req.url);
    const rawPath = decodeURIComponent(url.pathname);
    const routePath = rawPath === "/" ? "" : rawPath.replace(/^\//, "");
    let status = 200;

    try {
      if (url.pathname === "/favicon.ico") {
        const icon = Buffer.from(faviconBase64, "base64");
        const res = new Response(icon, { headers: { "Content-Type": "image/png" } });
        status = res.status;
        return res;
      }

      if (url.pathname === "/upload" && req.method === "POST") {
        const ip = clientIp(req, server);
        const now = Date.now() / 1000;
        const samples = (uploadRates.get(ip) ?? []).filter((t) => now - t < 60);
        if (samples.length >= 10) {
          status = 429;
          return new Response("Rate limit exceeded: Too many uploads from your IP in the last minute", { status });
        }
        samples.push(now);
        uploadRates.set(ip, samples);

        const form = await req.formData();
        const pathPart = String(form.get("path") ?? "");
        const files = form.getAll("file").filter((f): f is File => f instanceof File && f.size >= 0);
        if (!files.length) {
          status = 400;
          return new Response("No files uploaded: Please select files to upload", { status });
        }

        const uploaded: string[] = [];
        for (const file of files) {
          const filename = file.name;
          const savePath = safeJoin(servePath, pathPart, filename);
          await mkdir(resolve(savePath, ".."), { recursive: true });
          await Bun.write(savePath, file);
          uploaded.push(filename);
          console.info(`Uploaded file: ${filename} to ${pathPart}`);
        }

        if (!uploaded.length) {
          status = 500;
          return new Response("Upload failed: No files were successfully uploaded", { status });
        }

        const redirectPath = `/${pathPart
          .split("/")
          .filter(Boolean)
          .map(encodeURIComponent)
          .join("/")}`;
        status = 303;
        return new Response(null, {
          status,
          headers: { Location: redirectPath === "/" ? "/" : redirectPath },
        });
      }

      let path: string;
      try {
        path = safeJoin(servePath, routePath);
      } catch {
        status = 403;
        return new Response("Access Denied", { status });
      }

      if (!(await fileExists(path))) {
        status = 404;
        return new Response("Not Found", { status });
      }

      const pathStat = await stat(path);
      if (pathStat.isFile()) {
        const file = Bun.file(path);
        const headers = new Headers();
        headers.set("Content-Type", file.type || "application/octet-stream");
        if (url.searchParams.get("download") === "1") {
          headers.set("Content-Disposition", `attachment; filename="${path.split(/[\\/]/).at(-1) ?? "download"}"`);
        }
        const res = new Response(file, { headers });
        status = res.status;
        return res;
      }

      if (!pathStat.isDirectory()) {
        status = 404;
        return new Response("Not Found", { status });
      }

      const page = Number.parseInt(url.searchParams.get("page") ?? "1", 10) || 1;
      const sortByRaw = (url.searchParams.get("sort") ?? "name") as SortBy;
      const sortBy: SortBy = ["name", "size", "date"].includes(sortByRaw) ? sortByRaw : "name";
      const orderRaw = (url.searchParams.get("order") ?? "asc") as SortOrder;
      const order: SortOrder = orderRaw === "desc" ? "desc" : "asc";
      const perPage = 50;

      const files = await readdir(path);

      const sortable = await Promise.all(
        files.map(async (name: any) => {
          const abs = join(path, name);
          const st = await stat(abs);
          return {
            name,
            abs,
            st,
            size: st.isFile() ? st.size : 0,
            mtime: st.mtimeMs,
          };
        }),
      );

      sortable.sort((a, b) => {
        let cmp = 0;
        if (sortBy === "name") cmp = a.name.toLowerCase().localeCompare(b.name.toLowerCase());
        if (sortBy === "size") cmp = a.size - b.size;
        if (sortBy === "date") cmp = a.mtime - b.mtime;
        return order === "desc" ? -cmp : cmp;
      });

      const totalItems = sortable.length;
      const totalPages = Math.max(1, Math.ceil(totalItems / perPage));
      const safePage = Math.min(Math.max(page, 1), totalPages);
      const start = (safePage - 1) * perPage;
      const filesPage = sortable.slice(start, start + perPage);

      const breadcrumbs: Array<{ name: string; href: string }> = [];
      if (routePath) {
        const parts = routePath.split("/").filter(Boolean);
        let current = "";
        for (const part of parts) {
          current += `${part}/`;
          breadcrumbs.push({ name: part, href: current.replace(/\/$/, "") });
        }
      }

      let alt = false;
      const items = filesPage.map((item) => {
        const cssClass = alt ? "odd" : "even";
        alt = !alt;
        const isDir = item.st.isDirectory();
        const icon = getFileIcon(item.name, isDir);
        const size = isDir ? "" : formatSize(item.size);
        const mtime = new Date(item.st.mtimeMs).toISOString().replace("T", " ").slice(0, 19);
        const encoded = [routePath, item.name].filter(Boolean).join("/").split("/").map(encodeURIComponent).join("/");
        const href = `/${encoded}`;
        return { cssClass, icon, name: item.name, href, size, mtime };
      });

      const html = directoryPage({
        title: `Directory: ${routePath}`,
        items,
        pagination: totalPages > 1,
        page: safePage,
        totalPages,
        hostName: hostname(),
        env: process.env.ENV ?? "",
        breadcrumbs,
        sortBy,
        order,
        currentPath: routePath,
      });

      status = 200;
      return buildResponse(html, status);
    } catch (error) {
      console.error("Unhandled error", error);
      status = 500;
      return buildResponse(errorPage("500 Internal Server Error", "An internal error occurred"), status);
    } finally {
      const elapsed = Date.now() - started;
      const ua = req.headers.get("user-agent") ?? "Unknown";
      console.info(`${req.method} ${rawPath} - ${status} - IP: ${clientIp(req, server)} - UA: ${ua} - ${elapsed}ms`);
    }
  },
});

console.info(`Listening on http://${getLocalIPv4Address()}:${server.port}/`);
