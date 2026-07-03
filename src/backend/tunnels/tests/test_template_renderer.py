import unittest
from tunnels.tunnel_script_renderer import ssh_tunnel_script_factory
from tunnels.tunnel_script_renderer import PowerShellTemplate
from tunnels.tunnel_script_renderer import AutoSshTemplate

class TestPowerShellTemplate(unittest.TestCase):
    def setUp(self):
        self.template = ssh_tunnel_script_factory("powershell", "example.com", 8000, 22, 9000)

    def test_ps_template_factory(self):
        self.assertIsInstance(self.template, PowerShellTemplate)
        self.assertEqual(self.template.server_domain, "example.com")
        self.assertEqual(self.template.reverse_port, 8000)
        self.assertEqual(self.template.ssh_port, 22)
        self.assertEqual(self.template.reverse_server_ssh_port, 9000)

    def test_render(self):
        print("/// The line below is the rendered PowerShell script ///")
        rendered = self.template.render()
        self.assertIsInstance(rendered, str)
        print(rendered)

class TestAutoSshTemplate(unittest.TestCase):
    def setUp(self):
        self.template = ssh_tunnel_script_factory("autossh", "example.com", 8000, 22, 9000)

    def test_auto_ssh_template_factory(self):
        self.assertIsInstance(self.template, AutoSshTemplate)
        self.assertEqual(self.template.server_domain, "example.com")
        self.assertEqual(self.template.reverse_port, 8000)
        self.assertEqual(self.template.ssh_port, 22)
        self.assertEqual(self.template.reverse_server_ssh_port, 9000)

    def test_render(self):
        print("/// The line below is the rendered AutoSSH script ///")
        rendered = self.template.render()
        self.assertIsInstance(rendered, str)
        print(rendered)

if __name__ == "__main__":
    unittest.main()