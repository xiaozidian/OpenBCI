# OpenBCI 研究工作台

面向 **Cyton + Daisy** 的 16 通道学术工作台。把采集、波形与频谱、视觉刺激和事件日志放在一个浏览器界面中。独立社区原型，与 OpenBCI 官方 GUI 分开维护。

界面采用清华紫主色，校徽与校名使用项目所有者提供的原始图片；软件源码和品牌图像的权利说明见 [第三方组件说明](THIRD_PARTY_NOTICES.md)。

[打开在线模拟工作台](https://xiaozidian.github.io/OpenBCI/) · [下载本地工作台](https://xiaozidian.github.io/OpenBCI/downloads/OpenBCI-Research-Workbench.zip) · [使用说明](https://xiaozidian.github.io/OpenBCI/guide.html)

## 选择打开方式

| 方式 | 可以做什么 | 需要什么 |
| --- | --- | --- |
| 在线 / 双击 `web/index.html` | 16 通道模拟波形、显示滤波、频谱、事件和视觉刺激；下载模拟 CSV 与事件 JSON | 现代浏览器，无需安装依赖 |
| 本地工作台 | BrainFlow 模拟板或真实 Cyton + Daisy；连续原始记录与事件记录 | Python 3.10+、OpenBCI GUI 中的 Java 17 / BrainFlow 库 |

GitHub Pages 只托管静态网页，不运行 USB 采集服务。在线演示不会向访问者的本地服务发送请求，也不会连接 USB。真实采集请下载工作台并在本机运行；数据不会因 GitHub 同步而上传。

浏览器演示的数据由本项目在浏览器生成，**不等同于 BrainFlow Synthetic Board，也不是真实脑电**。数据暂存在当前页面内存，单次上限 10 分钟；停止后下载 CSV，刷新前导出事件日志。

## 在本机启动

1. 安装 [Python 3.10+](https://www.python.org/downloads/) 和 [OpenBCI GUI](https://openbci.com/downloads)。本机验证使用 GUI v6.0.0-beta.1 中的 Java 17 与 BrainFlow 5.10.0。
2. 下载分发 ZIP 并完整解压。
3. macOS 双击 `launch.command`；Windows 可运行 `launch.bat`；Linux 运行 `sh launch.sh`。也可执行：

   ```sh
   python3 launcher.py
   ```

4. 打开 `http://127.0.0.1:8765/`。保持采集服务的终端窗口运行；再次启动会打开已有工作台。
5. 结束时先点「停止并保存」，下载记录和事件日志，再在服务终端按 Ctrl+C。

**已在 Apple Silicon Mac + Rosetta + 上述 GUI / BrainFlow 版本验证真实板连接与数据传输。Windows / Linux 的启动器、串口枚举和运行时配置已提供，硬件采集尚未在这两个平台验证。** 分发包不包含 Python、OpenBCI GUI、Java 或 BrainFlow 原生二进制，因此不是独立免安装桌面应用。

如果 macOS 不允许双击脚本，可在终端进入解压目录执行 `python3 launcher.py`；无需关闭系统安全保护。

### GUI 安装在其他位置

macOS 默认识别 `/Applications/OpenBCI_GUI.app`。其他位置可设置：

```sh
OPENBCI_GUI_DIR="/path/to/OpenBCI_GUI" python3 launcher.py
```

也可分别设置 `OPENBCI_BRAINFLOW_DIR`（包含 `brainflow.jar` 及配套 JAR 的目录）、`OPENBCI_JAVA`（Java 17+ 可执行文件）。Java 与原生 BrainFlow 库的架构需要匹配。Windows 可在终端使用 `set OPENBCI_GUI_DIR=C:\path\to\OpenBCI_GUI`；Linux 为用户安装的 GUI 目录。端口可通过 `OPENBCI_PORT` 或 `python3 launcher.py --port 8766` 改变。

### 连接真实 Cyton + Daisy

1. 插入 USB 接收器；Cyton + Daisy 用电池供电并置于 PC。
2. 结束原 OpenBCI GUI 的采集，避免争用同一串口。
3. 选择「Cyton + Daisy · 真实板卡」，选择接收器串口，点击「开始采集」。
4. 工作台确认固件返回 16 通道响应后才启动流。常规无线流为 **16 通道 / 125 Hz**。
5. 未接电极时出现漂移、噪声或饱和不能代表有效脑电，也不能据此判断通道损坏。佩戴电极、参考和 BIAS 请遵循 [Daisy 官方接线指南](https://docs.openbci.com/GettingStarted/Boards/DaisyGS/)。

## 页面操作

- **实时采集**：连接状态、实际数据源、记录时长与服务器累计样本数同步显示。显示滤波、量程和 4 / 8 秒时间窗集中在波形上方。
- **暂停显示**：冻结波形与频谱，后台采集和原始记录继续；「停止并保存」才结束采集。
- **切换数据源**：先点「停止并保存」，再选择「模拟信号」或真实板，最后点击「开始采集」。采集中、显示暂停或等待新数据时，已有会话仍占用数据源，不能直接更换；停止后原记录保留在独立会话目录。
- 点击波形的通道行，或选择频谱通道，查看对应的功率谱密度。显示设置在浏览器本地保留。
- 原始电压可能有较大的直流偏置，超出微伏量程时曲线会被裁剪。「适应信号」自动选择显示量程，最大 ±250 mV；「原始信号居中显示」仅绘图时减去当前窗内均值，通道下方保留均值注释，不修改原始记录或频谱。
- 接近默认输入量程边界（约 ±187.5 mV）的通道会显示饱和提示。放大量程、居中或滤波不能恢复被饱和丢失的信号；请检查电极、参考和 BIAS。连续 3 秒未收到新样本时，状态切换为「等待新数据」。
- **实验与事件**：事件 A=1、B=2；该视图中非输入控件聚焦时，空格发送 A。范式准备 1 秒后开始，每次闪烁 150 ms。
- 离开刺激视图或将页面置于后台会取消剩余刺激；采集继续。
- 停止后「下载采集记录」下载 ZIP（本地）或 CSV（浏览器演示）；「导出事件日志」下载当前页面的实验 JSON。刷新页面会清除前端刺激日志，应先导出。

## 数据与研究边界

本地每次采集生成独立的 `recordings/日期_模式_编号/`，不会覆盖已有记录。

| 文件 | 内容 |
| --- | --- |
| `raw.csv` | 每行一个样本，保留全部 BrainFlow 数据列、EEG（μV）、包序号、时间戳和 marker |
| `events.tsv` | 请求、接受、落入样本或未观察到等状态；重复值有独立 event_id |
| `metadata.json` | 板型、通道布局、版本、固件响应、记录格式、结束状态 |
| `bridge.log` | 连接和运行日志 |

原始记录是未经本工作台显示滤波的 BrainFlow 输出，已经过单位换算和板型整理，不是原始 33 字节串口包。浏览器缓冲只保留最近数据，后端持续保存完整接收样本。

显示 DSP 沿用原实现：1–40 Hz 一阶高通 / 低通串联，50 Hz 二阶陷波 Q=30；PSD 使用最近 2 秒、去均值、Hann 窗和单边功率谱密度，分辨率 0.5 Hz。此次页面升级没有改变这些算法。正式研究应使用经过验证的处理流程。

Cyton + Daisy 的时间戳为主机接收 / 合并时间，软件 marker 排队进入后续样本。浏览器计划时间、requestAnimationFrame 回调时间、请求时间和标记样本时间分别记录；它们不代表屏幕实际亮起时间或硬件触发精度。`observed_sample_index` 是 raw.csv 去掉表头后的 0 基样本行号。不同进程的单调时钟原点不能直接互减。ERP、闭环和刺激锁定分析需外部触发或光电测量校准。

## 开发与发布

界面使用原生 HTML / CSS / JavaScript，无前端构建依赖、字体 CDN 或分析服务；后端使用 Python 标准库与 Java BrainFlow 桥接。

```sh
python3 -m unittest discover -s tests -p 'test_*.py'
node tests/demo.test.js
node --check web/app.js
python3 scripts/package.py
```

`dist/OpenBCI-Research-Workbench.zip` 为可分发源码包，旁边生成 SHA256 文件。打包采用文件白名单，排除 recordings、调试证据、原 GUI 安装包、凭据及本机运行时。

向 `main` 推送后，`.github/workflows/pages.yml` 先运行检查、生成下载包，再将 `web/` 发布至 GitHub Pages。仓库 Settings → Pages 的 Source 应设为 GitHub Actions。首次部署后网址为 `https://xiaozidian.github.io/OpenBCI/`。Fork 后网址中的账户和仓库名需相应调整，前端资源使用相对路径。

带 `v*` 标签的推送或手动运行 `Build release package` 会在 Actions 中生成可下载的分发附件。也可以将本地 ZIP 上传到 GitHub Releases；工作流不会自动创建公开 Release。

[发布与协作细节](docs/PUBLISHING.md) · [MIT License](LICENSE) · [第三方组件说明](THIRD_PARTY_NOTICES.md)
