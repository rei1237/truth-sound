from truth_sound.integrity import sha256_file


def test_sha256_known(tmp_path):
    p = tmp_path / "abc.bin"
    p.write_bytes(b"abc")
    assert sha256_file(p) == "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
