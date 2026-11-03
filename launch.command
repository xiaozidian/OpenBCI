#!/bin/zsh
cd -- "${0:A:h}" || exit 1
if ! command -v python3 >/dev/null 2>&1; then
  print "请先安装 Python 3.10+：https://www.python.org/downloads/"
  read "?按回车关闭窗口。"
  exit 1
fi
python3 launcher.py
result=$?
if [[ $result -ne 0 ]]; then
  print "启动失败，请查看上方提示与 README.md。"
  read "?按回车关闭窗口。"
fi
exit $result
