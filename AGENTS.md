# 工作区规则

- 使用 Node >=22.12；开发、构建和脚本均在 Node 22+ 执行。
- 界面优先组合现有 shadcn/ui：Button、Card、Input、Dialog、Select、Sidebar、Sheet、Tooltip 等；图标用 lucide-react。业务组件承载课程状态与请求，不另造平行控件体系。缺失的基础组件从 shadcn 官方补充。
- 数据、上传文件与生成文件只在 DATA_DIR，不能提交。禁止把私有课程、个人联系信息或密钥写入仓库。
- 通用协议、模型通道、提示词不包含学科专用或课程固定名称、页数；所有查询带课程维度。
- 变更后运行 typecheck、test、build；导入变更还需 smoke:import。
