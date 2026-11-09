' Запуск команды без окна консоли — для заданий расписания на ноутбуке Томаса.
' node.exe, запущенный планировщиком напрямую, каждый раз открывает чёрное окно
' (Томас, 09.11). Здесь окно скрыто (стиль 0), код завершения команды передаётся
' планировщику: проверка выноса читает его как «результат».
'   wscript.exe //B //Nologo run-hidden.vbs <программа> <аргументы…>
Set args = WScript.Arguments
If args.Count = 0 Then WScript.Quit 2
cmd = ""
For i = 0 To args.Count - 1
  cmd = cmd & " """ & args(i) & """"
Next
Set shell = CreateObject("WScript.Shell")
WScript.Quit shell.Run(Trim(cmd), 0, True)
