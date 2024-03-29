import unittest
from unittest.mock import Base
from tunnel_script_renderer import ssh_tunnel_script_factory
from tunnel_script_renderer.ssh_config_renderer import BaseSshTemplate

class TestSshBaseTemplate(unittest.TestCase):
    def setUp(self):
        self.template_client = BaseSshTemplate.template_factory(False, "halice-server", "halice.art", "test_user", 1234, 22, 4321)
        self.template_host = BaseSshTemplate.template_factory(True, "halice-server", "halice.art", "test_user", 1234, 22, 4321)

    def test_ps_template_factory(self):

        # Test client side.
        self.assertIsInstance(self.template_client, BaseSshTemplate)
        self.assertEqual(self.template_client.server_side, False)
        self.assertEqual(self.template_client.host_friendly_name, "halice-server")
        self.assertEqual(self.template_client.server_domain, "halice.art")
        self.assertEqual(self.template_client.ssh_username, "test_user")
        self.assertEqual(self.template_client.reverse_port, 1234)
        self.assertEqual(self.template_client.ssh_port, 22)
        self.assertEqual(self.template_client.reverse_server_ssh_port, 4321)

        # Test host side.
        self.assertIsInstance(self.template_host, BaseSshTemplate)
        self.assertEqual(self.template_host.server_side, True)
        self.assertEqual(self.template_host.host_friendly_name, "halice-server")
        self.assertEqual(self.template_host.server_domain, "halice.art")
        self.assertEqual(self.template_host.ssh_username, "test_user")
        self.assertEqual(self.template_host.reverse_port, 1234)
        self.assertEqual(self.template_host.ssh_port, 22)
        self.assertEqual(self.template_host.reverse_server_ssh_port, 4321)

    def test_render(self):
        print("/// The line below is the rendered SSH server config ///")
        rendered = self.template_host.render()
        self.assertIsInstance(rendered, str)
        print(rendered)

        print("/// The line below is the rendered SSH client config ///")
        rendered = self.template_client.render()
        self.assertIsInstance(rendered, str)
        print(rendered)



if __name__ == "__main__":
    unittest.main()