# 来源约定

## 产品交换范围

支持 KiCad 2025 S-expression 子集：kicad_sch、lib_symbols/symbol 的 unit 引脚定义、放置 symbol 的 lib_id/uuid/unit/body_style/properties/instances，以及 sheet 的 uuid、Sheetfile。/catalog 的 files 将交付相对路径映射到来源 URL，且是产品唯一允许取页的声明；sheet 文件名不会被产品自行拼成 URL。project=board；实例以完整 root/sheet UUID 路径区分，库符号身份不能替代实例身份。instances/project/path 中 reference/unit 优先于放置符号的 U? 占位文本，且只在完整路径与 project 都匹配时生效；不匹配时按未决项保留，不借用相邻路径的值。相同完整实例路径与 reference 的不同 unit 归属同器件，管脚仍保留 unit、body style 与原 symbol UUID。同一标号在不同库符号下不会合并，而以冲突形式保留。DNP、in_bom、on_board、exclude_from_sim 若提供则作为原声明保留，不替采购决定订料策略。不求导线连通或仿真，不要求绘制电路图。缺图、库定义及非法环需能表达受影响范围：未取到的子图、缺失的库定义或 unit、缺失的实例路径与环都进入未决项，不中止其余可解析资料的交付，也不用别页同名符号补齐。

## 当前来源路由

- `/primary`：text/plain
- `/child.kicad_sch`：text/plain
- `/hierarchy.kicad_sch`、`/amp-a.kicad_sch`、`/amp-b.kicad_sch`、`/nolib.kicad_sch`、`/cycle.kicad_sch`：text/plain，层次领取样例

`/catalog` 提供入口、project 及 files 声明。资源字节支持 GET/HEAD、单一 bytes 范围、ETag 和 If-Match，响应不会跨来源重定向。`/_phase` 为联调控制路径，不是产品数据来源，不应由产品自行切换阶段。

## 依据和范围说明

- https://dev-docs.kicad.org/en/file-formats/sexpr-schematic/

以上是格式或业务词汇的公开依据；本项目明确限定的交换子集以本文及实际资源为准，未要求完整标准实现。元数据和未支持声明应保留可定位的来源，不把未知转换成已确认的空结果。HTTP 来源状态、原件结构和产品接收完整性是不同层次；现有通用收件接口成功只表示该单件已保存，层次领取的 pages 记录补齐了实际取到的每一页。
