[![Open in Colab](https://colab.research.google.com/assets/colab-badge.svg)](https://colab.research.google.com/drive/1l1fAyDzNSSCVOF_JBpXRp2b3SHuI5bz6?usp=sharing) Accuracy 100% CAPTCHA weight: xserver_captcha.keras [repo](https://github.com/GitHub30/captcha-cloudrun)

[![](https://github.com/user-attachments/assets/f3db034f-1b1b-4983-9f9a-06a3aeb1b64e)](https://colab.research.google.com/drive/1l1fAyDzNSSCVOF_JBpXRp2b3SHuI5bz6?usp=sharing)

マニュアル
https://motoki-design.co.jp/wordpress/xserver-vps-auto-renew/

Manual
https://motoki-design.co.jp/wordpress/xserver-vps-auto-renew/

手册
https://motoki-design.co.jp/wordpress/xserver-vps-auto-renew/

![Clipchamp7-ezgif com-video-to-gif-converter](https://github.com/user-attachments/assets/745a85ef-0d5a-4532-9774-3b7fcb2c8b52)

我制作了 Tampermonkey [Install](https://raw.githubusercontent.com/GitHub30/extend-vps-exp/refs/heads/main/renew.user.js) 然后，请访问：https://secure.xserver.ne.jp/xapanel/login/xvps/

如果不起作用，请设置 GitHub Actions 的 Secrets 环境变量。

```env
EMAIL=your@gmail.com
PASSWORD=yourpassword
PROXY_SERVER=http://user:password@example.com:8888
```

<details><summary>安装代理服务器</summary>

```bash
apt update
apt install -y tinyproxy
echo Allow 0.0.0.0/0 >> /etc/tinyproxy/tinyproxy.conf
echo BasicAuth user password >> /etc/tinyproxy/tinyproxy.conf
systemctl restart tinyproxy
systemctl status tinyproxy
```
</details>

## 设置步骤
1. 关闭 XServer 的可疑登录验证
   登录 XServer 面板 → 登録情報確認・編集 → 将「不審なログイン時の認証」设为無効。否则从 GitHub Actions 的新 IP 登录会被拦截。

2. Fork 仓库

3. 配置 GitHub Secrets
在你 fork 的仓库中：

进入 Settings → Secrets and variables → Actions
点击 New repository secret，添加以下两个：
EMAIL — XServer VPS 登录邮箱
PASSWORD — XServer VPS 登录密码
PROXY_SERVER — 代理服务器地址（xserverip:port），格式：http://user:password@xserverip:8888

代理的工作流程

GitHub Actions (美国IP) → 代理服务器 (日本IP) → XServer VPS 面板
你需要一台有固定 IP 的服务器（最好在日本）来运行代理。讽刺的是，你的 XServer 免费 VPS 本身就可以用来做这件事。

第一步：SSH 登录到你的 VPS

ssh root@你的VPS_IP地址

第二步：安装 tinyproxy

```shell
# 更新包列表
apt update

# 安装 tinyproxy（轻量级 HTTP 代理）
apt install -y tinyproxy

# 允许所有 IP 连接（GitHub Actions IP 不固定，所以需要 0.0.0.0/0）
echo "Allow 0.0.0.0/0" >> /etc/tinyproxy/tinyproxy.conf

# 设置用户名密码认证（防止代理被滥用）
# 把 user 和 password 替换成你自己的用户名和密码
echo "BasicAuth user password" >> /etc/tinyproxy/tinyproxy.conf

# 重启 tinyproxy 使配置生效
systemctl restart tinyproxy

# 检查是否运行正常（应显示 active (running)）
systemctl status tinyproxy
```

tinyproxy 默认端口是 8888。

第三步：确保防火墙放行 8888 端口
如果你的 VPS 有防火墙（XServer VPS 面板里可能有安全组设置），需要放行 TCP 8888 端口。

第四步：在 GitHub 仓库中配置 PROXY_SERVER Secret
回到 GitHub 仓库 → Settings → Secrets and variables → Actions → New repository secret：

- Name: PROXY_SERVER
- Value: http://user:password@你的VPS_IP:8888




4. 启用 GitHub Actions
进入仓库的 Actions 页签
首次需要点击同意启用
选择 .github/workflows/main.yml workflow
点击 Enable workflow
点击 Run workflow 手动触发一次测试
验证是否成功
运行后在 Actions 页面点击对应的 workflow run，下载 artifact.zip，解压后查看 recording.webm 视频，可以看到自动操作的全过程。

我想去西門町，和大家一起喝珍珠奶茶。
