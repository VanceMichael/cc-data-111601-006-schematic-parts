# schematic-parts

层次电路图中器件实例与管脚资料采集相关资料接收服务，面向授权来源的原件领取、解释和持久查询。

## 当前能力

可沿来源声明的子图关系领取整份层次 KiCad 原理图：读取库符号定义、放置实例与多单元器件的管脚，并保留装配属性与未决项。

`src/reader.mjs` 解析单页 S-expression，区分 `lib_symbols` 库定义与放置的 `symbol`；`src/hierarchy.mjs` 沿 `sheet`/`Sheetfile` 递归展开完整实例路径，按实例标号聚合同一器件的多个单元；`src/claim.mjs` 通过来源 `/catalog` 的声明取页并把每页原件交给存储；`src/transport.mjs` 只访问配置来源的同源地址，拒绝隐式跳转；`src/store.mjs` 保存原件摘要和解释结果。`src/service.mjs` 是产品入口，`src/provider.mjs` 是独立 HTTP 联调来源，内容为无个人信息的本地样例。

层次领取的分层语义：

- 页面按文件只取一次；同一子图文件经不同 sheet UUID 放置多次时，按完整实例路径（`/<root-uuid>/<sheet-uuid>/...`）保留为相互独立的放置实例，绝不合并。
- 器件是采购单位：共享实例标号（`instances/project/path` 中的 `reference`）的多个单元视为同一芯片，即使分别画在不同页；同路径同标号的不同 unit 归属同器件，管脚仍保留原 unit、body style 与原 symbol UUID。
- `U?` 等未标注参考标号不是身份，不会被跨路径合并；仅凭放置符号属性取到的标号会标记 `reference_from_property`。
- 每个管脚携带所在实例的标号、完整实例路径、symbol UUID、库名、unit、电气类型与图形样式，以及该实例的 `dnp`/`in_bom`/`on_board`/`exclude_from_sim` 原声明。不对这些声明做订料判断，也不做电气仿真。
- 缺子图、缺库定义、缺单元、缺实例路径和子图环都进入 `unresolved`，保留 path/file/symbol 等可追查字段；缺库定义时不会用另一页的同名符号补上，未在 `/catalog` 中声明的子图也不会被自行抓取。
- 同一标号指向不同库符号时不会合并成一个器件，而是拆分并标记 `reference_library_conflict`。

## 环境与运行

Node.js 22.22 至 22.x，无 npm 依赖，无外部运行服务或下载步骤。Linux、Windows 均使用以下命令；干净目录可直接运行。

```sh
npm ci --offline --ignore-scripts
npm test
npm run build
npm run demo
```

`npm run demo` 自动在本机回环端口启动来源与产品、领取单件资料、对层次样例执行一次完整领取（含多单元器件、复用子图与未决项），读取已保存结果，然后关闭服务并清理临时目录。它展示当前产品能力，不模拟尚不存在的能力。演示没有固定等待、外网访问或人工操作，通常数秒结束。扩展产品后可按实际能力更新演示路径；不要以打印预先保存的结果替代运行。

直接 `npm start` 即可启动产品，默认自动在临时回环端口创建本地合成来源，产品默认监听 127.0.0.1:4102。退出产品时同步关闭自带来源。需要联调独立来源时先运行 `npm run source`，再设置 SOURCE_URL=http://127.0.0.1:4101 运行 `npm start`；显式来源不会由产品关闭。DATA_DIR 可设置资料目录，PORT 可覆盖产品监听端口。构建产物位于 dist，启动、测试与演示均不需要外部服务或下载。

## 已有接口

- GET /health：服务状态。
- POST /intakes，JSON 为 {"path":"/primary"}：按现有 reader 接收单件原件；内容解释失败不登记资料。
- POST /claims，JSON 可为空或 {"path":"/hierarchy.kicad_sch"}：按来源目录声明领取一份层次原理图，未给 path 时使用 `/catalog` 的 entry。返回 pages、libraries、placements、devices 与 unresolved；每个已取页同时作为单件原件持久化。来源不可达的页进入 unresolved，不会中止其余领取。
- GET /records：持久接收目录；同 source URL、同摘要重领返回原 id。
- GET /objects/{digest}：读取已保存的原始字节。

`/intakes`、`/records`、`/objects` 与 `/health` 是兼容接口，`/claims` 为新增业务入口；不能把 GET 请求变为写操作。`/records` 中的单件记录表示原件已保存，不表示其关联层次资料已完整。

## 来源与资料

交换范围、字段和边界见 [来源约定](docs/upstream.md)，样例资源清单可访问来源的 /catalog。`fixtures/upstream.json` 描述 HTTP 资源和阶段变体，不包含产品实现。GET /_requests 可查实际领取请求；POST /_phase 接收 {"phase":1} 切换已定义的来源状态，切回 0 恢复。所有资料都限于公开约定或本地合成数据，不向真实业务系统写入。

## 测试与构建

`npm test` 覆盖读取器、畸形输入、真实 HTTP 领取、原件一致性、持久重开、同源边界和范围响应；层次读取行为在 test/domain.test.mjs 与 test/hierarchy.test.mjs，`/claims` 端到端行为在 test/integration.test.mjs。`npm run build` 对运行模块逐个执行语法校验并复制到 dist。`docker build -t schematic-parts:local .` 可创建产品运行镜像；镜像默认运行实际演示，不含远程业务凭据。
