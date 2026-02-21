import unittest
from unittest.mock import Base
from tunnel_script_renderer import sshd_client_config_factory, sshd_server_config_factory
from tunnel_script_renderer import SshClientTemplate, SshServerTemplate


class TestSshClientTemplate(unittest.TestCase):
    def setUp(self):
        self.template_client = sshd_client_config_factory("halice-server", "test_user", 1234)

    def test_ps_template_factory(self):

        # Test client side.
        self.assertIsInstance(self.template_client, SshClientTemplate)
        self.assertEqual(self.template_client.server_side, False)
        self.assertEqual(self.template_client.host_friendly_name, "halice-server")
        self.assertEqual(self.template_client.server_domain, "localhost")
        self.assertEqual(self.template_client.ssh_username, "test_user")
        self.assertEqual(self.template_client.reverse_port, 1234)

    def test_render(self):

        print("/// The line below is the rendered SSH client config ///")
        rendered = self.template_client.render()
        self.assertIsInstance(rendered, str)
        print(rendered)

class TestSshServerTemplate(unittest.TestCase):
    def setUp(self):
        self.template_host = sshd_server_config_factory("halice.art", 4321)

    def test_ps_template_factory(self):

        # Test host side.
        self.assertIsInstance(self.template_host, SshServerTemplate)
        self.assertEqual(self.template_host.server_side, True)
        self.assertEqual(self.template_host.host_friendly_name, "telepy-ssh-server")
        self.assertEqual(self.template_host.server_domain, "halice.art")
        self.assertEqual(self.template_host.ssh_username, "telepy")
        self.assertEqual(self.template_host.reverse_server_ssh_port, 4321)

    def test_render(self):

        print("/// The line below is the rendered SSH server config ///")
        rendered = self.template_host.render()
        self.assertIsInstance(rendered, str)
        print(rendered)

if __name__ == "__main__":
    unittest.main()