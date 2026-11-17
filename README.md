# schematic-parts

层次电路图中器件实例与管脚资料采集相关资料接收服务，面向授权来源的原件领取、解释和持久查询。

## 当前能力

可读取单页 KiCad S-expression 中的符号属性和库定义；`src/hierarchy.mjs` 按来源声明的子图关系（`/catalog` 的 `files` 与 sheet 的 `Sheetfile`）展开完整层次，得到每个具体实例路径下的放置实例、多单元器件和管脚清单。

`src/reader.mjs` 提供单页读取契约；`src/hierarchy.mjs` 做层次展开；`src/transport.mjs` 只访问配置来源的同源地址，拒绝隐式跳转；`src/store.mjs` 保存原件摘要、解释结果和层次领取结果。`src/service.mjs` 是产品入口，`src/provider.mjs` 是独立 HTTP 联调来源，内容为无个人信息的本地样例。

层次领取区分三层记录：库符号定义（`library_symbols`，按页归属）、放置实例（`placements`，以完整实例路径 `/root/sheet-uuid` 和 symbol UUID 区分）、器件（`devices`，按项目内参考标号归并多单元）。管脚同时带 `reference`、`unit`、实例路径、所在页和该实例的 `assembly`（dnp/in_bom/on_board 原声明）。同一子图文件的多个路径实例各自独立，不合并；相同完整路径下同参考标号的不同单元才归并为同一器件。

缺子图、缺库定义、路径声明缺失、单元越界、非法环等不会被静默忽略：`unresolved` 列出可追查的未决项（含页、实例路径、symbol UUID、库名，缺库时还带 `declaring_pages` 作为调查线索）。不同页的同名库符号不会被借来顶替缺失定义；库符号的 `extends` 只在同页内解析。

## 环境与运行

Node.js 22.22 至 22.x，无 npm 依赖，无外部运行服务或下载步骤。Linux、Windows 均使用以下命令；干净目录可直接运行。

```sh
npm ci --offline --ignore-scripts
npm test
npm run build
npm run demo
```

`npm run demo` 自动在本机回环端口启动来源与产品，领取入口页并按声明的子图关系取得实际实例，读取已保存结果，再展示子图暂不可得时保留的未决项，然后关闭服务并清理临时目录。它展示当前产品能力，不模拟尚不存在的能力。演示没有固定等待、外网访问或人工操作，通常数秒结束。扩展产品后可按实际能力更新演示路径；不要以打印预先保存的结果替代运行。

分开运行时，先 `npm run source`，来源监听 127.0.0.1:4101；在另一终端设置 SOURCE_URL=http://127.0.0.1:4101 后运行 `npm start`，产品默认 4102。DATA_DIR 可设置资料目录，PORT 可分别覆盖监听端口。构建产物位于 dist，当前脚本仅使用 Node 内置模块。

## 已有接口

- GET /health：服务状态。
- POST /intakes，JSON 为 {"path":"/primary"}：按现有 reader 接收单件原件；内容解释失败不登记资料。
- GET /records：持久接收目录；同 source URL、同摘要重领返回原 id。
- GET /objects/{digest}：读取已保存的原始字节。
- POST /deliveries，JSON 为 {"path":"/primary"}：层次领取。读取入口页，沿已声明子图关系展开；保存每个已读页原件，返回 `summary`、`result.devices`、`result.placements`、`result.sheets`、`result.unresolved` 等。同来源、同页集合重领返回同一记录。
- GET /deliveries：已保存的层次领取摘要列表。
- GET /deliveries/{id}：读取一次层次领取的完整解释结果。

前四项是兼容接口；新增业务入口不把 GET 请求变为写操作。`POST /intakes` 的收件记录仍只包含单件 raw 对象，不代表关联资料已完整；`POST /deliveries` 才表达一次层次领取。

## 来源与资料

交换范围、字段和边界见 [来源约定](docs/upstream.md)，样例资源清单可访问来源的 /catalog。`fixtures/upstream.json` 描述 HTTP 资源和阶段变体，不包含产品实现。GET /_requests 可查实际领取请求；POST /_phase 接收 {"phase":1} 切换已定义的来源状态，切回 0 恢复。所有资料都限于公开约定或本地合成数据，不向真实业务系统写入。

## 测试与构建

`npm test` 覆盖单页读取器、畸形输入、真实 HTTP 领取、原件一致性、持久重开、同源边界、范围响应及层次展开与未决项；领域读取行为在 test/domain.test.mjs，层次行为在 test/hierarchy.test.mjs。`npm run build` 对运行模块逐个执行语法校验并复制到 dist。`docker build -t schematic-parts:local .` 可创建产品运行镜像；镜像默认运行实际演示，不含远程业务凭据。
