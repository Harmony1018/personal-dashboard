# 选择日期的小窗口。由 import-data.bat 调用，把选中的日期打到标准输出。
#
# 为什么要用 PowerShell 而不是继续用 .bat：cmd.exe 只能打印文字、读一行输入，
# 画不出任何图形控件。PowerShell 能调用 Windows 自己的对话框控件。
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$form = New-Object System.Windows.Forms.Form
$form.Text = '选择这份数据属于哪一天'
$form.Size = New-Object System.Drawing.Size(360, 170)
$form.StartPosition = 'CenterScreen'
$form.FormBorderStyle = 'FixedDialog'
$form.MaximizeBox = $false
$form.MinimizeBox = $false
$form.TopMost = $true

# 默认用「日历下拉」样式，点右边箭头展开月历选。
$picker = New-Object System.Windows.Forms.DateTimePicker
$picker.Format = [System.Windows.Forms.DateTimePickerFormat]::Custom
$picker.CustomFormat = 'yyyy-MM-dd'
$picker.Location = New-Object System.Drawing.Point(30, 28)
$picker.Size = New-Object System.Drawing.Size(280, 28)

$ok = New-Object System.Windows.Forms.Button
$ok.Text = '确定'
$ok.Size = New-Object System.Drawing.Size(100, 32)
$ok.Location = New-Object System.Drawing.Point(60, 80)
$ok.DialogResult = [System.Windows.Forms.DialogResult]::OK

$cancel = New-Object System.Windows.Forms.Button
$cancel.Text = '取消'
$cancel.Size = New-Object System.Drawing.Size(100, 32)
$cancel.Location = New-Object System.Drawing.Point(180, 80)
$cancel.DialogResult = [System.Windows.Forms.DialogResult]::Cancel

$form.Controls.Add($picker)
$form.Controls.Add($ok)
$form.Controls.Add($cancel)
$form.AcceptButton = $ok
$form.CancelButton = $cancel

if ($form.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {
  Write-Output $picker.Value.ToString('yyyy-MM-dd')
} else {
  Write-Output 'CANCELLED'
}
